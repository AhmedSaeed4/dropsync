import { auth, db } from './firebase';
import { deleteDoc, doc, collection, query, where, getDoc, getDocFromServer, getDocs, getDocsFromServer, updateDoc, QueryDocumentSnapshot } from 'firebase/firestore';
import { deleteConversation } from './chat';
import { deleteMasterKey } from './crypto';
import { deleteFromR2 } from './drops';
import { PROFILES_COLLECTION, getProfile } from './profiles';
import { deleteSharesForDrop } from './shares';
import { acquireAccountBarrier, completeAccountBarrier, abortAccountBarrier } from './accountBarriers';
import { getImportFenceOutstanding } from './importFenceClient';
import { runDeletionJob, isDeletionPaused } from './workspaceDeletion';
import { withUserArchiveLock } from './archiveJobLock';
import { getArchiveTaskManager } from './archiveTaskManager';

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

// ROUND 12 (F5): the solo-workspace key cleanup is CHECKED + retried — the workspace-doc
// delete waits for a confirmed ack instead of swallowing failures (an orphaned key was the
// old best-effort hole). On persistent failure the caller aborts the whole flow
// (resumable). The TRANSFER branch never calls this — the key is deliberately RETAINED
// (the workspace survives with its new owner).
async function cleanupWorkspaceKeyChecked(workspaceId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) return false;
      const res = await fetch('/api/cleanup-workspace-key', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (json.ok === true) return true;
      }
    } catch (error) {
      console.error('Workspace key cleanup attempt failed:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return false;
}

// ROUND 12 (part L / D-l, finish-the-job-first): adopt and finish every background
// deletion job this user owns (runDeletionJob is idempotent + authoritative-requery).
// Returns the ids that did NOT finish (empty = drained). Deliberately ONE filter
// (array-contains — auto-indexed); ownership + deleting are filtered client-side to
// avoid an unprovisioned composite index.
async function drainOwnedDeletionJobs(userId: string): Promise<string[]> {
  const ownedSnap = await getDocs(
    query(collection(db, WORKSPACES_COLLECTION), where('members', 'array-contains', userId))
  );
  const unfinished: string[] = [];
  for (const wsDoc of ownedSnap.docs) {
    const data = wsDoc.data();
    if (data.deleting !== true || data.ownerId !== userId) continue;
    await runDeletionJob(wsDoc.id);
    if (isDeletionPaused(wsDoc.id)) {
      unfinished.push(wsDoc.id);
      continue;
    }
    const after = await getDoc(doc(db, WORKSPACES_COLLECTION, wsDoc.id));
    if (after.exists()) unfinished.push(wsDoc.id);
  }
  return unfinished;
}

// Verify the shared recovery pass has closed and acknowledged every owned import before
// account deletion mutates any drop or workspace. The account barrier prevents new imports.
async function drainOpenImportFences(userId: string): Promise<boolean> {
  try {
    // The lock-held recovery above closed and verified each import before the barrier.
    // The barrier now prevents another producer from opening one. Re-read server truth;
    // never acknowledge an item merely because deletion was attempted.
    const fences = await getDocsFromServer(query(collection(db, 'importFences'), where('userId', '==', userId)));
    for (const fence of fences.docs) {
      const data = fence.data();
      if (data.state === 'closed-success') continue;
      if (data.state !== 'closed-cancelled' || typeof data.jobId !== 'string') return false;
      const status = await getImportFenceOutstanding(data.jobId);
      if (!status || status.state !== 'closed-cancelled' || status.outstandingItems !== 0) return false;
    }
    return true;
  } catch (error) {
    console.error('Import fence verification failed:', error);
    return false;
  }
}

/**
 * Delete user account and all associated data
 */
export async function deleteAccount(
  userId: string,
  selectedOwners: SelectedOwners = {},
  onProgress?: (progress: DeletionProgress) => void
): Promise<{ success: boolean; error?: string }> {
  if (getArchiveTaskManager().isBusyForUid(userId)) {
    return { success: false, error: 'Finish the archive or its cleanup before deleting your account.' };
  }
  try {
    return await withUserArchiveLock(userId, 'account', async () => {
      if (getArchiveTaskManager().isBusyForUid(userId)) {
        return { success: false, error: 'Finish the archive or its cleanup before deleting your account.' };
      }
      return deleteAccountUnderHeldLock(userId, selectedOwners, onProgress);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not acquire the account safety lock.' };
  }
}

async function deleteAccountUnderHeldLock(
  userId: string,
  selectedOwners: SelectedOwners,
  onProgress?: (progress: DeletionProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    let currentStep = 0;
    const totalSteps = 10; // 10 onProgress steps (ROUND 12: + the drain step; FCM cleaned server-side in Step 5)
    const firebaseUser = auth.currentUser;

    if (!firebaseUser || firebaseUser.uid !== userId) {
      return { success: false, error: 'User not authenticated' };
    }

    const barrierSnapshot = await getDocFromServer(doc(db, 'accountBarriers', userId));
    const priorBarrierState = barrierSnapshot.exists() ? barrierSnapshot.get('state') : 'none';
    // A resumed active barrier cannot admit a new import; take over its owned
    // fences under the account lock. A new barrier respects a fresh remote lease.
    const remoteActive = await getArchiveTaskManager().recoverUnderHeldLock(userId, priorBarrierState === 'active');
    if (remoteActive) return { success: false, error: 'A backup is active on another device. Try again when it finishes.' };

    // Step 0 (ROUND 12 part K): acquire the barrier. `finalizing` = a previous attempt
    // already committed the finalizer — resume the committed tail; nothing else remains.
    // Every early failure below ABORTS the barrier so the living owner is never locked out.
    const barrier = await acquireAccountBarrier();
    if (!barrier.ok || !barrier.state) {
      return { success: false, error: 'Could not start account deletion — check your connection and try again.' };
    }
    if (barrier.state === 'finalizing') {
      onProgress?.({ step: 'Deleting account', current: totalSteps, total: totalSteps });
      await firebaseUser.delete();
      return { success: true };
    }

    // Step 0.5 (ROUND 12 part L / D-l, finish-the-job-first): adopt and complete every
    // background deletion this user owns. Unfinished work ABORTS with a resumable message.
    onProgress?.({ step: 'Finishing in-progress deletions', current: ++currentStep, total: totalSteps });
    const unfinishedJobs = await drainOwnedDeletionJobs(userId);
    if (unfinishedJobs.length > 0) {
      await abortAccountBarrier();
      return { success: false, error: 'A workspace is still being deleted — wait for it to finish, then try again.' };
    }

    // Step 0.6: verify the lock-held recovery pass emptied every cancelled ledger.
    if (!(await drainOpenImportFences(userId))) {
      await abortAccountBarrier();
      return { success: false, error: 'Could not finish cleaning up an interrupted import — please try again.' };
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

    // Step 2: Handle workspaces. ROUND 12: each doc is RE-READ fresh before its mutation —
    // the drain above is the authority for deleting workspaces, and a re-read that still
    // shows `deleting` (a race the barrier makes impossible; belt-and-braces) surfaces a
    // clean resumable error instead of a raw permission-denied.
    onProgress?.({ step: 'Processing workspaces', current: ++currentStep, total: totalSteps });
    const workspacesQuery = query(
      collection(db, WORKSPACES_COLLECTION),
      where('members', 'array-contains', userId)
    );
    const workspacesSnap = await getDocs(workspacesQuery);

    for (const workspaceDoc of workspacesSnap.docs) {
      const workspaceRef = doc(db, WORKSPACES_COLLECTION, workspaceDoc.id);
      const freshSnap = await getDoc(workspaceRef);
      if (!freshSnap.exists()) continue; // finished deleting between the query and now
      const data = freshSnap.data() ?? {};
      if (data.deleting === true) {
        await abortAccountBarrier();
        return { success: false, error: 'A workspace is still being deleted — wait for it to finish, then try again.' };
      }

      // (best-effort, FOLDED into this workspace loop — no second query) Delete this user's group-chat
      // read cursor workspaces/{wsId}/readState/{uid} NOW, while they are still a member (the rule
      // requires current membership for the write). Firestore does NOT cascade-delete subcollections,
      // so the members-removal / workspace-delete below would otherwise orphan this doc. deleteDoc on
      // a missing readState doc is a no-op. MUST run before the mutation in this iteration.
      try {
        await deleteDoc(doc(db, WORKSPACES_COLLECTION, workspaceDoc.id, 'readState', userId));
      } catch (error) {
        console.error('Failed to delete group-chat read state:', error);
      }

      if (data.ownerId === userId) {
        // User is owner
        const members = Array.isArray(data.members) ? data.members : [];
        const otherMembers = members.filter((id: string) => id !== userId);

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
          // ROUND 12 (F5): the key cleanup is CHECKED + retried and the workspace-doc
          // delete WAITS for the confirmed ack — a swallowed failure could orphan the key.
          // (On the transfer branch below the key is deliberately RETAINED.)
          const keyCleaned = await cleanupWorkspaceKeyChecked(workspaceDoc.id);
          if (!keyCleaned) {
            await abortAccountBarrier();
            return { success: false, error: "Couldn't delete a workspace encryption key — please try again." };
          }
          // Delete workspace
          await deleteDoc(workspaceRef);
        } else {
          // Transfer ownership to selected member or first remaining member. The key is
          // deliberately RETAINED (ROUND 12 F5): the workspace survives with its new owner.
          const newOwnerId = selectedOwners[workspaceDoc.id] || otherMembers[0];
          await updateDoc(workspaceRef, {
            ownerId: newOwnerId,
            members: otherMembers,
          });
        }
      } else {
        // User is a member - remove from members array. (If this workspace is deleting the
        // guard above already returned; ordinary leaves ride the frozen job fields
        // unchanged, which the rules admit.)
        const members = Array.isArray(data.members) ? data.members : [];
        if (!members.includes(userId)) continue; // already out (race with a concurrent leave)
        const updatedMembers = members.filter((id: string) => id !== userId);
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
    // delete on chats + its subcollections allowed when auth.uid == userId → ALLOWED.
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
    // the fcmTokens subcollection read is rule-locked, so we POST to /api/cleanup-fcm-tokens, which
    // uses the Admin SDK (bypasses rules) and deletes only the VERIFIED caller's own tokens (uid from
    // verifyIdToken — never from the body). MUST run BEFORE the finalizer + firebaseUser.delete():
    // after the Auth deletion getIdToken() throws (no token to send). Best-effort: try/catch.
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
    // && createdBy == uid). Workspace-scoped categories are excluded by the workspaceId == null filter
    // → untouched (they belong to the workspace).
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

    // Step 9 (ROUND 12 part K, F1): the FINALIZER — barrier-complete commits `finalizing`
    // atomically and MUST be the last token-bearing call before the Auth deletion. On a
    // refusal (another device's abort) or a network failure the flow HALTS: without a
    // committed finalizer the Auth deletion must never run. A lost response recovers on
    // the next attempt (acquire → finalizing → the resume tail in Step 0).
    onProgress?.({ step: 'Deleting account', current: ++currentStep, total: totalSteps });
    const completion = await completeAccountBarrier();
    if (!completion.ok) {
      return {
        success: false,
        error: completion.refused
          ? 'Account deletion was cancelled on another device.'
          : 'Could not finish account deletion — please try again.',
      };
    }
    await firebaseUser.delete();

    return { success: true };
  } catch (error: unknown) {
    // ROUND 12: any unexpected failure best-effort releases the barrier so the living
    // owner can retry. (Abort refuses once `finalizing` committed — a harmless no-op; the
    // resume tail above owns that state.)
    await abortAccountBarrier();
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
