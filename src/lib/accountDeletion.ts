import { auth, db } from './firebase';
import { deleteDoc, doc, collection, query, where, getDocs, updateDoc, getDoc } from 'firebase/firestore';
import { deleteMasterKey } from './crypto';

const USERS_COLLECTION = 'users';
const USER_KEYS_COLLECTION = 'userKeys';
const WORKSPACES_COLLECTION = 'workspaces';
const DROPS_COLLECTION = 'drops';

export interface WorkspaceMember {
  uid: string;
  displayName: string | null;
  email: string | null;
}

export interface DeletionPreview {
  personalDrops: number;
  workspacesOwned: { id: string; name: string; members: WorkspaceMember[] }[];
  workspacesMemberOf: { id: string; name: string }[];
  totalSteps: number;
}

export interface DeletionProgress {
  step: string;
  current: number;
  total: number;
}

// Selected new owners for each workspace (workspaceId -> newOwnerId)
export type SelectedOwners = Record<string, string>;

/**
 * Preview what will be deleted before account deletion
 */
export async function previewAccountDeletion(userId: string): Promise<DeletionPreview> {
  // Count personal drops
  const personalDropsQuery = query(
    collection(db, DROPS_COLLECTION),
    where('userId', '==', userId),
    where('workspaceId', '==', null)
  );
  const personalDropsSnap = await getDocs(personalDropsQuery);
  const personalDrops = personalDropsSnap.size;

  // Get all workspaces where user is a member
  const workspacesQuery = query(
    collection(db, WORKSPACES_COLLECTION),
    where('members', 'array-contains', userId)
  );
  const workspacesSnap = await getDocs(workspacesQuery);

  const workspacesOwned: DeletionPreview['workspacesOwned'] = [];
  const workspacesMemberOf: DeletionPreview['workspacesMemberOf'] = [];

  // Collect all unique member IDs to fetch
  const allMemberIds = new Set<string>();
  workspacesSnap.forEach((workspaceDoc) => {
    const data = workspaceDoc.data();
    data.members.forEach((id: string) => {
      if (id !== userId) {
        allMemberIds.add(id);
      }
    });
  });

  // Fetch member details
  const memberDetails: Record<string, WorkspaceMember> = {};
  if (allMemberIds.size > 0) {
    // Fetch each user document individually
    const fetchPromises = Array.from(allMemberIds).map(async (memberId) => {
      const userRef = doc(db, USERS_COLLECTION, memberId);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const data = userSnap.data();
        memberDetails[memberId] = {
          uid: memberId,
          displayName: data.displayName || null,
          email: data.email || null,
        };
      } else {
        memberDetails[memberId] = {
          uid: memberId,
          displayName: null,
          email: memberId,
        };
      }
    });
    await Promise.all(fetchPromises);
  }

  workspacesSnap.forEach((workspaceDoc) => {
    const data = workspaceDoc.data();
    if (data.ownerId === userId) {
      // Get other members with their details
      const otherMembers: WorkspaceMember[] = data.members
        .filter((id: string) => id !== userId)
        .map((id: string) => memberDetails[id] || { uid: id, displayName: null, email: id });

      workspacesOwned.push({
        id: workspaceDoc.id,
        name: data.name,
        members: otherMembers,
      });
    } else {
      workspacesMemberOf.push({
        id: workspaceDoc.id,
        name: data.name,
      });
    }
  });

  const totalSteps =
    personalDrops +                           // Delete each personal drop
    workspacesOwned.length +                  // Transfer/delete owned workspaces
    workspacesMemberOf.length +               // Leave member workspaces
    4;                                        // Delete user doc, keys, IndexedDB, auth

  return {
    personalDrops,
    workspacesOwned,
    workspacesMemberOf,
    totalSteps,
  };
}

/**
 * Delete user account and all associated data
 */
export async function deleteAccount(
  userId: string,
  selectedOwners: SelectedOwners = {},
  onProgress?: (progress: DeletionProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    let currentStep = 0;
    const totalSteps = 10; // Approximate
    const firebaseUser = auth.currentUser;

    if (!firebaseUser || firebaseUser.uid !== userId) {
      return { success: false, error: 'User not authenticated' };
    }

    // Step 1: Delete personal drops (workspaceId: null)
    onProgress?.({ step: 'Deleting personal drops', current: ++currentStep, total: totalSteps });
    const personalDropsQuery = query(
      collection(db, DROPS_COLLECTION),
      where('userId', '==', userId),
      where('workspaceId', '==', null)
    );
    const personalDropsSnap = await getDocs(personalDropsQuery);

    for (const dropDoc of personalDropsSnap.docs) {
      await deleteDoc(dropDoc.ref);
    }

    // Step 2: Handle workspaces
    onProgress?.({ step: 'Processing workspaces', current: ++currentStep, total: totalSteps });
    const workspacesQuery = query(
      collection(db, WORKSPACES_COLLECTION),
      where('members', 'array-contains', userId)
    );
    const workspacesSnap = await getDocs(workspacesQuery);

    for (const workspaceDoc of workspacesSnap.docs) {
      const data = workspaceDoc.data();
      const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceDoc.id);

      if (data.ownerId === userId) {
        // User is owner
        const otherMembers = data.members.filter((id: string) => id !== userId);

        if (otherMembers.length === 0) {
          // No other members - delete workspace and its drops
          const workspaceDropsQuery = query(
            collection(db, DROPS_COLLECTION),
            where('workspaceId', '==', workspaceDoc.id)
          );
          const workspaceDropsSnap = await getDocs(workspaceDropsQuery);
          for (const dropDoc of workspaceDropsSnap.docs) {
            await deleteDoc(dropDoc.ref);
          }
          // Delete workspace
          await deleteDoc(workspaceRef);
        } else {
          // Transfer ownership to selected member or first remaining member
          const newOwnerId = selectedOwners[workspaceDoc.id] || otherMembers[0];
          await updateDoc(workspaceRef, {
            ownerId: newOwnerId,
            members: otherMembers,
          });
        }
      } else {
        // User is a member - remove from members array
        const updatedMembers = data.members.filter((id: string) => id !== userId);
        await updateDoc(workspaceRef, {
          members: updatedMembers,
        });
      }
    }

    // Step 3: Delete user document
    onProgress?.({ step: 'Deleting user data', current: ++currentStep, total: totalSteps });
    await deleteDoc(doc(db, USERS_COLLECTION, userId));

    // Step 4: Delete user keys from Firestore
    onProgress?.({ step: 'Deleting encryption keys', current: ++currentStep, total: totalSteps });
    await deleteDoc(doc(db, USER_KEYS_COLLECTION, userId));

    // Step 5: Delete IndexedDB master key
    onProgress?.({ step: 'Cleaning up local data', current: ++currentStep, total: totalSteps });
    await deleteMasterKey(userId);

    // Step 6: Delete Firebase Auth user
    onProgress?.({ step: 'Deleting account', current: ++currentStep, total: totalSteps });
    await firebaseUser.delete();

    return { success: true };
  } catch (error: unknown) {
    const errorCode = (error as { code?: string })?.code;
    let errorMessage = 'Failed to delete account';

    if (errorCode === 'auth/requires-recent-login') {
      errorMessage = 'Please re-authenticate and try again';
    } else if (errorCode === 'auth/user-not-found') {
      errorMessage = 'User not found';
    }

    console.error('Account deletion error:', error);
    return { success: false, error: errorMessage };
  }
}