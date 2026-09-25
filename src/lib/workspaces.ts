import { getAuth } from 'firebase/auth';
import {
  collection,
  addDoc,
  arrayRemove,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  getDoc,
  runTransaction,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from './firebase';
import { assertWorkspaceWritableById } from './archiveJournalVisibility';
import { createArchiveStatusTracker, isArchiveRecordStaged, subscribeArchiveJournalTransitions } from './archiveJournalVisibility';
import { Workspace } from '@/types';
import { createWorkspaceKey, removeMemberFromWorkspaceKey } from './keys';
import { getProfile } from './profiles';

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

// Generate a random 6-character invite code (CSPRNG, rejection-sampled — mirrors generateShareId in shares.ts)
function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const limit = Math.floor(256 / chars.length) * chars.length; // largest multiple of 36 ≤ 256 (= 252)
  const randomValues = new Uint8Array(6);
  crypto.getRandomValues(randomValues);

  let code = '';
  for (let i = 0; i < 6; i++) {
    let byte = randomValues[i];
    while (byte >= limit) {
      const next = new Uint8Array(1);
      crypto.getRandomValues(next);
      byte = next[0];
    }
    code += chars.charAt(byte % chars.length);
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

    // Create workspace encryption key — and CONSUME the boolean (ROUND 12 part C): a failed
    // key init surfaces as a visible failure (no silent keyless workspace, no silent
    // success). The parent doc is removed best-effort; no deletion job exists here.
    const keyOk = await createWorkspaceKey(docRef.id, userId);
    if (!keyOk) {
      try {
        await deleteDoc(docRef);
      } catch {
        /* best-effort rollback */
      }
      return null;
    }

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

// Leave a workspace. ROUND 12 (A2): read-then-act in ONE transaction — the owner leg
// (solo delete / ownership transfer) REFUSES a deleting workspace (D-l: the deletion job
// finishes instead; no successor handoff), and no caller can act on a stale pre-read.
// The caller propagates the false result.
export async function leaveWorkspace(userId: string, workspaceId: string, newOwnerId?: string): Promise<boolean> {
  try {
    await assertWorkspaceWritableById(workspaceId);
    const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceId);

    const outcome = await runTransaction(db, async (tx) => {
      const snapshot = await tx.get(workspaceRef);
      if (!snapshot.exists) return { ok: false as const };
      const data = snapshot.data() as { ownerId?: string; members?: string[]; deleting?: boolean };
      const members: string[] = Array.isArray(data.members) ? data.members : [];
      const updatedMembers = members.filter((id: string) => id !== userId);

      if (data.ownerId === userId) {
        if (data.deleting === true) {
          // The deleting owner cannot leave/transfer a dying workspace.
          return { ok: false as const };
        }
        if (updatedMembers.length === 0) {
          // Last member: delete the workspace (the ordinary non-deleting solo path).
          tx.delete(workspaceRef);
        } else {
          // Transfer ownership: prefer the caller's chosen successor (must be a remaining
          // member), else fall back to the first remaining member.
          const successor = newOwnerId && updatedMembers.includes(newOwnerId)
            ? newOwnerId
            : updatedMembers[0];
          tx.update(workspaceRef, {
            members: updatedMembers,
            ownerId: successor
          });
        }
      } else {
        // Member self-leave (legal even while deleting — walking out of a dying workspace
        // is allowed; the rules admit the members-only diff).
        tx.update(workspaceRef, {
          members: updatedMembers
        });
      }
      return { ok: true as const };
    });

    if (!outcome.ok) return false;

    // Remove member's access to workspace encryption key
    await removeMemberFromWorkspaceKey(workspaceId, userId);

    return true;
  } catch (error) {
    console.error('Error leaving workspace:', error);
    return false;
  }
}

// Owner removes another member. Client-side (rule-legal via the owner update branch:
// resource.data.ownerId == request.auth.uid is an unrestricted standalone disjunct, so a single
// updateDoc by the owner passes as-is — NO firestore.rules change).
// Revocation is rules-level only: the kicked uid instantly loses all live + future reads
// (workspaces/messages/readState/workspaceKeys/drops/categories all re-check membership on every
// read), so their listeners degrade to empty — no crash, no key work needed.
// removeMemberFromWorkspaceKey is a deliberate no-op (return true), called for parity with
// leaveWorkspace only — it rotates nothing and re-encrypts nothing (the shared workspace key is
// unchanged; remaining members keep decrypting as before).
// The invite code is rotated so the kicked member cannot rejoin with the old code.
export async function kickWorkspaceMember(
  ownerId: string,
  workspaceId: string,
  memberUid: string
): Promise<boolean> {
  try {
    await assertWorkspaceWritableById(workspaceId);
    const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceId);
    const snapshot = await getDoc(workspaceRef);

    if (!snapshot.exists()) return false;

    const data = snapshot.data();
    if (data.ownerId !== ownerId) return false;         // only the owner kicks
    if (ownerId === memberUid) return false;             // self-remove is leave, not kick
    if (!data.members.includes(memberUid)) return true;  // idempotent short-circuit

    await updateDoc(workspaceRef, {
      members: arrayRemove(memberUid),
      inviteCode: generateInviteCode(),                  // rotate → blocks rejoin via old code
    });
    await removeMemberFromWorkspaceKey(workspaceId, memberUid); // no-op, parity with leave
    return true;
  } catch (error) {
    console.error('Error kicking member:', error);
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

  // ROUND 12: metadata-aware (progress writes and server reconciliation land as metadata
  // changes too) and the frozen job fields ride along so the UI can render the locked row.
  let project: (() => void) | null = null;
  const tracker = createArchiveStatusTracker(() => project?.());
  const releaseJournal = subscribeArchiveJournalTransitions(() => project?.());
  const releaseWorkspaces = onSnapshot(q, (snapshot) => {
    project = () => {
    tracker.update(snapshot.docs.flatMap((item) => {
      const data = item.data();
      return typeof data.importJobId === 'string' ? [{ ownerId: data.ownerId as string, jobId: data.importJobId }] : [];
    }));
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
        deleting: data.deleting === true ? true : undefined,
        deletingStartedAt: typeof data.deletingStartedAt === 'number' ? data.deletingStartedAt : undefined,
        deletingOwner: typeof data.deletingOwner === 'string' ? data.deletingOwner : undefined,
        deletingOwnerName: typeof data.deletingOwnerName === 'string' ? data.deletingOwnerName : undefined,
        deletingRecipients: Array.isArray(data.deletingRecipients) ? data.deletingRecipients as string[] : undefined,
        deleteDone: typeof data.deleteDone === 'number' ? data.deleteDone : undefined,
        deleteTotal: typeof data.deleteTotal === 'number' ? data.deleteTotal : undefined,
        importJobId: typeof data.importJobId === 'string' ? data.importJobId : undefined,
        isImporting: typeof data.importJobId === 'string' ? isArchiveRecordStaged(data.ownerId, data.importJobId) : false,
      });
    });

    // Sort by name
    workspaces.sort((a, b) => a.name.localeCompare(b.name));
    callback(workspaces);
    };
    project();
  }, (error) => {
    if (error?.code === 'permission-denied') return; // expected during sign-out teardown — ignore
    console.error('Workspaces listener error:', error);
    callback([]);
  });
  return () => { releaseWorkspaces(); releaseJournal(); tracker.close(); };
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
