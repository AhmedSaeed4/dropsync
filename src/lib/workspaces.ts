import { getAuth } from 'firebase/auth';
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  getDoc,
  getDocs,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from './firebase';
import { Workspace } from '@/types';
import { createWorkspaceKey, removeMemberFromWorkspaceKey } from './keys';
import { getProfile } from './profiles';
import { deleteSharesForDrop } from './shares';

const WORKSPACES_COLLECTION = 'workspaces';

export interface MemberInfo {
  uid: string;
  displayName: string;
  isOwner: boolean;
}

// Fetch display names for workspace members
export async function getWorkspaceMembers(
  memberIds: string[],
  ownerId: string
): Promise<MemberInfo[]> {
  const members: MemberInfo[] = [];

  // Read each member's display name from the world-readable profiles collection (NOT users/{uid},
  // which is self/owner-only after the lock). Falls back to uid if no profile doc / no displayName.
  const fetchPromises = memberIds.map(async (uid) => {
    const profile = await getProfile(uid);
    const displayName = profile?.displayName || uid;
    return { uid, displayName, isOwner: uid === ownerId };
  });

  const results = await Promise.all(fetchPromises);

  // Owner first, then alphabetically
  results.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return results;
}

// Generate a random 6-character invite code
function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Create a new workspace
export async function createWorkspace(userId: string, name: string): Promise<Workspace | null> {
  try {
    const inviteCode = generateInviteCode();

    const docRef = await addDoc(collection(db, WORKSPACES_COLLECTION), {
      name,
      ownerId: userId,
      members: [userId],
      inviteCode,
      createdAt: serverTimestamp(),
    });

    // Create workspace encryption key
    await createWorkspaceKey(docRef.id, userId);

    return {
      id: docRef.id,
      name,
      ownerId: userId,
      members: [userId],
      inviteCode,
      createdAt: new Date(),
    };
  } catch (error) {
    console.error('Error creating workspace:', error);
    return null;
  }
}

// Join a workspace using an invite code. Routes through the server-side Admin SDK endpoint
// /api/workspaces/join (Release 1 of server-side invite-code enforcement) — the Admin SDK bypasses
// firestore.rules, so the membership add is enforced server-side rather than via a client write.
// The route is USER-gated (any authenticated user holding a valid code), normalizes the code, does
// the membership add atomically via FieldValue.arrayUnion, and returns the joined workspace.
//
// Signature + the { workspace, error? } return shape are unchanged so useWorkspaces.join,
// handleJoinWorkspace, and both JoinWorkspaceModals stay untouched. The three server error strings
// ("Invalid invite code" / "You are already a member of this workspace" / "Failed to join
// workspace") pass through verbatim.
//
// NOTE: `userId` is no longer used in the body — the server derives the joining uid from the
// verified ID token, so the client-passed value is intentionally not trusted for the write. The
// parameter is kept to preserve the call-site signature (noUnusedParameters is off).
export async function joinWorkspace(userId: string, inviteCode: string): Promise<{ workspace: Workspace | null; error?: string }> {
  try {
    const token = await getAuth().currentUser?.getIdToken();
    if (!token) {
      return { workspace: null, error: 'Failed to join workspace' };
    }

    const res = await fetch('/api/workspaces/join', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode }),
    });

    const json = await res.json();
    if (!res.ok || json.error) {
      return { workspace: null, error: json.error ?? 'Failed to join workspace' };
    }

    return {
      workspace: {
        id: json.workspaceId,
        name: json.name,
        ownerId: json.ownerId,
        members: json.members,
        inviteCode: json.inviteCode,
        // The route deliberately omits createdAt. Synthesize the client-side fallback the original
        // code already tolerated (|| new Date()): neither consumer (useWorkspaces.join /
        // handleJoinWorkspace) reads createdAt, and the live createWorkspacesListener onSnapshot
        // re-emits the real value the instant the membership write lands — so this is invisible.
        createdAt: new Date(),
      },
    };
  } catch (error) {
    console.error('Error joining workspace:', error);
    return { workspace: null, error: 'Failed to join workspace' };
  }
}

// Leave a workspace
export async function leaveWorkspace(userId: string, workspaceId: string, newOwnerId?: string): Promise<boolean> {
  try {
    const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceId);
    const snapshot = await getDoc(workspaceRef);

    if (!snapshot.exists()) return false;

    const data = snapshot.data();
    const updatedMembers = data.members.filter((id: string) => id !== userId);

    // If owner leaves, transfer ownership or delete if last member
    if (data.ownerId === userId) {
      if (updatedMembers.length === 0) {
        // Delete workspace if no members left
        await deleteDoc(workspaceRef);
      } else {
        // Transfer ownership: prefer the caller's chosen successor (must be a remaining
        // member), else fall back to the first remaining member.
        const successor = newOwnerId && updatedMembers.includes(newOwnerId)
          ? newOwnerId
          : updatedMembers[0];
        await updateDoc(workspaceRef, {
          members: updatedMembers,
          ownerId: successor
        });
      }
    } else {
      await updateDoc(workspaceRef, {
        members: updatedMembers
      });
    }

    // Remove member's access to workspace encryption key
    await removeMemberFromWorkspaceKey(workspaceId, userId);

    return true;
  } catch (error) {
    console.error('Error leaving workspace:', error);
    return false;
  }
}

// Subscribe to user's workspaces
export function createWorkspacesListener(
  userId: string,
  callback: (workspaces: Workspace[]) => void
): () => void {
  const q = query(
    collection(db, WORKSPACES_COLLECTION),
    where('members', 'array-contains', userId)
  );

  return onSnapshot(q, (snapshot) => {
    const workspaces: Workspace[] = [];

    snapshot.forEach((document) => {
      const data = document.data();
      workspaces.push({
        id: document.id,
        name: data.name,
        ownerId: data.ownerId,
        members: data.members,
        inviteCode: data.inviteCode,
        createdAt: data.createdAt?.toDate() || new Date(),
      });
    });

    // Sort by name
    workspaces.sort((a, b) => a.name.localeCompare(b.name));
    callback(workspaces);
  }, (error) => {
    console.error('Workspaces listener error:', error);
    callback([]);
  });
}

// Delete a workspace (owner only)
export async function deleteWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  try {
    const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceId);
    const snapshot = await getDoc(workspaceRef);

    if (!snapshot.exists()) return false;

    const data = snapshot.data();

    // Only owner can delete
    if (data.ownerId !== userId) return false;

    // Delete all drops in the workspace first
    const dropsQuery = query(
      collection(db, 'drops'),
      where('workspaceId', '==', workspaceId)
    );
    const dropsSnapshot = await getDocs(dropsQuery);

    // Delete drops from R2 and Firestore (mirror deleteDrop)
    const { deleteFromR2 } = await import('./drops');
    for (const dropDoc of dropsSnapshot.docs) {
      const dropData = dropDoc.data();
      if (dropData.r2Key) {
        try {
          await deleteFromR2(dropData.r2Key, workspaceId);
        } catch (error) {
          console.error('Failed to delete R2 file:', error);
        }
      }
      if (dropData.imageR2Key) {
        try {
          await deleteFromR2(dropData.imageR2Key, workspaceId);
        } catch (error) {
          console.error('Failed to delete image from R2:', error);
        }
      }
      await deleteDoc(doc(db, 'drops', dropDoc.id));
      // Delete associated share links (best-effort — swallows its own errors)
      await deleteSharesForDrop(dropDoc.id);
    }

    // Delete this workspace's categories (best-effort — never block deletion on a cleanup
    // failure). Only workspace-scoped categories are touched; personal categories
    // (workspaceId == null) are never deleted.
    try {
      const catsQuery = query(collection(db, 'categories'), where('workspaceId', '==', workspaceId));
      const catsSnapshot = await getDocs(catsQuery);
      for (const catDoc of catsSnapshot.docs) {
        try {
          await deleteDoc(catDoc.ref);
        } catch (error) {
          console.error('Failed to delete category:', error);
        }
      }
    } catch (error) {
      console.error('Failed to query categories for cleanup:', error);
    }

    // Delete the workspace
    await deleteDoc(workspaceRef);

    return true;
  } catch (error) {
    console.error('Error deleting workspace:', error);
    return false;
  }
}

// Get workspace by ID
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  try {
    const snapshot = await getDoc(doc(db, WORKSPACES_COLLECTION, workspaceId));

    if (!snapshot.exists()) return null;

    const data = snapshot.data();
    return {
      id: workspaceId,
      name: data.name,
      ownerId: data.ownerId,
      members: data.members,
      inviteCode: data.inviteCode,
      createdAt: data.createdAt?.toDate() || new Date(),
    };
  } catch (error) {
    console.error('Error getting workspace:', error);
    return null;
  }
}