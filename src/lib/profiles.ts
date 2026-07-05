/**
 * World-readable user display profiles.
 *
 * Sensitive fields (email, tier, emailVerified, activity, prefs) live in the self/owner-only
 * users/{uid} doc; only the display fields (displayName, photoURL) are mirrored here so any
 * logged-in user can render another user's name in workspace member lists and the account-deletion
 * peer picker without reading anyone's email. This is the email-PII half of the same split pattern
 * the publicKey-split (keys.ts) used for userPublicKeys.
 */

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export const PROFILES_COLLECTION = 'profiles';
const USERS_COLLECTION = 'users';

export interface ProfileDoc {
  displayName: string | null;
  photoURL: string | null;
}

// Lazy self-migration — MIRRORS ensurePublicKeyPublished in keys.ts.
//
// CRITICAL: the source displayName/photoURL are read from this user's OWN users/{uid} doc (a self
// read, allowed both before AND after the users read-lock), NOT from Firebase Auth. signUpWithEmail
// writes displayName to Firestore but never calls Firebase updateProfile, so email/password users
// carry a null Auth displayName — sourcing from Auth would write null here, and the one-shot
// migrate-profiles backfill would then skip them (nothing to mirror) = permanent name loss.
//
// Idempotent: no-op if the profiles doc already exists. Best-effort: a missing users doc just
// writes null fields (harmless; the doc existence is what gates future runs).
export async function ensureProfilePublished(userId: string): Promise<void> {
  const profileRef = doc(db, PROFILES_COLLECTION, userId);
  if ((await getDoc(profileRef)).exists()) return;
  const userSnap = await getDoc(doc(db, USERS_COLLECTION, userId));
  const data = userSnap.data() as { displayName?: string | null; photoURL?: string | null } | undefined;
  await setDoc(profileRef, {
    displayName: data?.displayName ?? null,
    photoURL: data?.photoURL ?? null,
    createdAt: serverTimestamp(),
  });
}

// Single cross-user read used by getWorkspaceMembers + previewAccountDeletion. Reads from the
// world-readable profiles collection (NOT the self/owner-only users doc), so it works for any
// logged-in user looking up any other user's display fields.
export async function getProfile(userId: string): Promise<ProfileDoc | null> {
  const snap = await getDoc(doc(db, PROFILES_COLLECTION, userId));
  if (!snap.exists()) return null;
  const data = snap.data() as { displayName?: string | null; photoURL?: string | null };
  return { displayName: data.displayName ?? null, photoURL: data.photoURL ?? null };
}
