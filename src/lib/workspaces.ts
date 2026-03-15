import {
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  getDocs,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from './firebase';
import { Workspace } from '@/types';

const WORKSPACES_COLLECTION = 'workspaces';

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

// Join a workspace using invite code
export async function joinWorkspace(userId: string, inviteCode: string): Promise<{ workspace: Workspace | null; error?: string }> {
  try {
    // Find workspace with this invite code
    const q = query(
      collection(db, WORKSPACES_COLLECTION),
      where('inviteCode', '==', inviteCode.toUpperCase())
    );

    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return { workspace: null, error: 'Invalid invite code' };
    }

    const workspaceDoc = snapshot.docs[0];
    const data = workspaceDoc.data();

    // Check if already a member
    if (data.members.includes(userId)) {
      return { workspace: null, error: 'You are already a member of this workspace' };
    }

    // Add user to members
    const updatedMembers = [...data.members, userId];
    await updateDoc(doc(db, WORKSPACES_COLLECTION, workspaceDoc.id), {
      members: updatedMembers
    });

    return {
      workspace: {
        id: workspaceDoc.id,
        name: data.name,
        ownerId: data.ownerId,
        members: updatedMembers,
        inviteCode: data.inviteCode,
        createdAt: data.createdAt?.toDate() || new Date(),
      }
    };
  } catch (error) {
    console.error('Error joining workspace:', error);
    return { workspace: null, error: 'Failed to join workspace' };
  }
}

// Leave a workspace
export async function leaveWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  try {
    const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceId);
    const snapshot = await getDocs(
      query(collection(db, WORKSPACES_COLLECTION), where('__name__', '==', workspaceId))
    );

    if (snapshot.empty) return false;

    const data = snapshot.docs[0].data();
    const updatedMembers = data.members.filter((id: string) => id !== userId);

    // If owner leaves, transfer ownership or delete if last member
    if (data.ownerId === userId) {
      if (updatedMembers.length === 0) {
        // Delete workspace if no members left
        await deleteDoc(workspaceRef);
      } else {
        // Transfer ownership to next member
        await updateDoc(workspaceRef, {
          members: updatedMembers,
          ownerId: updatedMembers[0]
        });
      }
    } else {
      await updateDoc(workspaceRef, {
        members: updatedMembers
      });
    }

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

// Get workspace by ID
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  try {
    const snapshot = await getDocs(
      query(collection(db, WORKSPACES_COLLECTION), where('__name__', '==', workspaceId))
    );

    if (snapshot.empty) return null;

    const data = snapshot.docs[0].data();
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