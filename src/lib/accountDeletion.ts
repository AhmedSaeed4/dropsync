import { auth, db } from './firebase';
import { deleteDoc, doc, collection, query, where, getDocs, updateDoc, QueryDocumentSnapshot } from 'firebase/firestore';
import { deleteConversation } from './chat';
import { deleteMasterKey } from './crypto';
import { deleteFromR2 } from './drops';
import { PROFILES_COLLECTION, getProfile } from './profiles';
import { deleteSharesForDrop } from './shares';

const USERS_COLLECTION = 'users';
const USER_KEYS_COLLECTION = 'userKeys';
const USER_PUBLIC_KEYS_COLLECTION = 'userPublicKeys';
const WORKSPACES_COLLECTION = 'workspaces';
const DROPS_COLLECTION = 'drops';
const CATEGORIES_COLLECTION = 'categories';

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

  // Fetch member display names from the world-readable profiles collection (NOT users/{uid},
  // which is self/owner-only after the lock — peer email is no longer readable cross-user, by
  // design). email is null for co-members; the transfer-ownership picker falls back to uid.
  const memberDetails: Record<string, WorkspaceMember> = {};
  if (allMemberIds.size > 0) {
    const fetchPromises = Array.from(allMemberIds).map(async (memberId) => {
      const profile = await getProfile(memberId);
      memberDetails[memberId] = {
        uid: memberId,
        displayName: profile?.displayName || null,
        email: null,
      };
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

// Best-effort: delete a drop's R2 file + attached image + share links, then the doc.
// Mirrors deleteDrop (drops.ts). R2/share failures are swallowed + logged so a
// missing object never aborts account deletion.
async function deleteDropWithAttachments(dropDoc: QueryDocumentSnapshot) {
  const data = dropDoc.data();
  if (data.r2Key) {
    try {
      await deleteFromR2(data.r2Key, data.workspaceId || null);
    } catch (error) {
      console.error('Failed to delete R2 file:', error);
    }
  }
  if (data.imageR2Key) {
    try {
      await deleteFromR2(data.imageR2Key, data.workspaceId || null);
    } catch (error) {
      console.error('Failed to delete image from R2:', error);
    }
  }
  await deleteSharesForDrop(dropDoc.id);
  await deleteDoc(dropDoc.ref);
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
    const totalSteps = 9; // 9 onProgress steps (FCM tokens now cleaned server-side in Step 4)
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
      await deleteDropWithAttachments(dropDoc);
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

      // (best-effort, FOLDED into this workspace loop — no second query) Delete this user's group-chat
      // read cursor workspaces/{wsId}/readState/{uid} NOW, while they are still a member (the rule at
      // firestore.rules:213-220 requires current membership for the write). Firestore does NOT cascade-
      // delete subcollections, so the members-removal / workspace-delete below would otherwise orphan
      // this doc. deleteDoc on a missing readState doc is a no-op. Rule: allow write (covers delete) if
      // auth.uid == userId && current member → ALLOWED. MUST run before the mutation in this iteration.
      try {
        await deleteDoc(doc(db, WORKSPACES_COLLECTION, workspaceDoc.id, 'readState', userId));
      } catch (error) {
        console.error('Failed to delete group-chat read state:', error);
      }

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
            await deleteDropWithAttachments(dropDoc);
          }
          // Best-effort: delete this workspace's encryption key SERVER-SIDE via the Admin SDK (the
          // client cannot — firestore.rules has no `allow delete` on workspaceKeys). MUST run BEFORE
          // the workspace-doc delete below, while the route can still re-verify ownership. A failure
          // logs and falls through to today's behavior (workspace still deletes; the key may orphan —
          // inert, as before). Uses the in-scope current user's token (same one Step 4's FCM cleanup
          // uses); workspaceDoc.id is this owned workspace's id.
          try {
            const idToken = await firebaseUser.getIdToken();
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            try {
              await fetch('/api/cleanup-workspace-key', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: workspaceDoc.id }),
                signal: ctrl.signal,
              });
            } finally {
              clearTimeout(t);
            }
          } catch (e) {
            console.error('Failed to clean workspace key server-side:', e);
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

    // Step 3 (best-effort): Delete the user's AI assistant chat history (chats/{uid}/conversations/
    // {convId}/messages/{msgId} + each conversation doc, then the chats/{uid} parent as an idempotent
    // tidy-up). Plaintext personal AI history was previously never touched on account deletion. Reuses
    // deleteConversation (already wipes a conversation's messages then its doc). The chats/{uid} parent
    // is usually an implied, doc-less path segment, so deleting it is a harmless no-op. Rule: read/write/
    // delete on chats + its subcollections allowed when auth.uid == userId (firestore.rules:292-308) → ALLOWED.
    onProgress?.({ step: 'Deleting AI chat history', current: ++currentStep, total: totalSteps });
    try {
      const conversationsSnap = await getDocs(collection(db, 'chats', userId, 'conversations'));
      for (const convDoc of conversationsSnap.docs) {
        try {
          await deleteConversation(userId, convDoc.id);
        } catch (error) {
          console.error('Failed to delete AI conversation:', error);
        }
      }
      // Idempotent tidy-up of the (usually implied, doc-less) chats/{uid} parent path segment.
      await deleteDoc(doc(db, 'chats', userId));
    } catch (error) {
      console.error('Failed to delete AI chat history:', error);
    }

    // Step 4 (best-effort): Delete ALL this user's FCM push tokens SERVER-SIDE. The client cannot —
    // the fcmTokens subcollection read is rule-locked (`allow read: if false`, firestore.rules:80), so
    // we POST to /api/cleanup-fcm-tokens, which uses the Admin SDK (bypasses rules) and deletes only
    // the VERIFIED caller's own tokens (uid from verifyIdToken — never from the body). MUST run BEFORE
    // firebaseUser.delete() (Step 9): after it the Auth user is gone, so getIdToken() throws (no
    // token to send) → the cleanup can't run. Best-effort: try/catch, never aborts deletion.
    onProgress?.({ step: 'Cleaning push tokens', current: ++currentStep, total: totalSteps });
    try {
      const idToken = await firebaseUser.getIdToken();
      await fetch('/api/cleanup-fcm-tokens', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      });
    } catch (error) {
      console.error('Failed to clean FCM tokens server-side:', error);
    }

    // Step 5 (best-effort): Delete the user's PERSONAL categories (categories where workspaceId == null
    // && createdBy == uid). workspaces.ts:310-312 notes personal categories are never deleted on
    // workspace teardown — this fixes that for ACCOUNT deletion. Workspace-scoped categories are
    // excluded by the workspaceId == null filter → untouched (they belong to the workspace). Rule:
    // read/delete allowed for the creator on personal categories (firestore.rules:275-276, :284-285) → ALLOWED.
    onProgress?.({ step: 'Deleting personal categories', current: ++currentStep, total: totalSteps });
    try {
      const personalCatsQuery = query(
        collection(db, CATEGORIES_COLLECTION),
        where('createdBy', '==', userId),
        where('workspaceId', '==', null),
      );
      const personalCatsSnap = await getDocs(personalCatsQuery);
      for (const catDoc of personalCatsSnap.docs) {
        try {
          await deleteDoc(catDoc.ref);
        } catch (error) {
          console.error('Failed to delete personal category:', error);
        }
      }
    } catch (error) {
      console.error('Failed to query personal categories for cleanup:', error);
    }

    // Step 6: Delete user document
    onProgress?.({ step: 'Deleting user data', current: ++currentStep, total: totalSteps });
    await deleteDoc(doc(db, USERS_COLLECTION, userId));
    // Also delete the world-readable profile doc so it isn't orphaned (displayName/photoURL moved
    // here). Mirrors the userPublicKeys delete below.
    await deleteDoc(doc(db, PROFILES_COLLECTION, userId));

    // Step 7: Delete user keys from Firestore
    onProgress?.({ step: 'Deleting encryption keys', current: ++currentStep, total: totalSteps });
    await deleteDoc(doc(db, USER_KEYS_COLLECTION, userId));
    // Also delete the mirrored world-readable publicKey doc so it isn't orphaned.
    await deleteDoc(doc(db, USER_PUBLIC_KEYS_COLLECTION, userId));

    // Step 8: Delete IndexedDB master key
    onProgress?.({ step: 'Cleaning up local data', current: ++currentStep, total: totalSteps });
    await deleteMasterKey(userId);

    // Step 9: Delete Firebase Auth user
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