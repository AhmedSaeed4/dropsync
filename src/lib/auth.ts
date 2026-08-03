import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  EmailAuthProvider,
  updateProfile
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp, getDoc, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebase';
import { clearFcmToken } from './notifications';
import { PROFILES_COLLECTION } from './profiles';
import { User } from '@/types';

const provider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User | null> {
  try {
    const result = await signInWithPopup(auth, provider);
    const firebaseUser = result.user;

    // Create or update user document
    const userRef = doc(db, 'users', firebaseUser.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      // New user — write users/{uid} (sensitive: email + tier + activity) and profiles/{uid}
      // (world-readable displayName/photoURL) atomically via writeBatch. Mirrors initializeUserKeys.
      const batch = writeBatch(db);
      batch.set(userRef, {
        email: firebaseUser.email,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        tier: 'standard',
      });
      batch.set(doc(db, PROFILES_COLLECTION, firebaseUser.uid), {
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
      });
      await batch.commit();
    } else {
      await setDoc(userRef, {
        lastActive: serverTimestamp(),
      }, { merge: true });
    }

    return {
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.displayName,
      photoURL: firebaseUser.photoURL,
      emailVerified: firebaseUser.emailVerified,
    };
  } catch (error) {
    return null;
  }
}

export async function signOut(): Promise<void> {
  // Remove this device's push token BEFORE signing out, while still authenticated, so a shared
  // computer stops receiving this user's notifications. Best-effort — clearFcmToken never throws.
  try {
    await clearFcmToken();
  } catch {}
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    // Silent fail
  }
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
    if (firebaseUser) {
      callback({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
        emailVerified: firebaseUser.emailVerified,
      });
    } else {
      callback(null);
    }
  });
}

export function getCurrentUser(): User | null {
  const firebaseUser = auth.currentUser;
  if (firebaseUser) {
    return {
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      displayName: firebaseUser.displayName,
      photoURL: firebaseUser.photoURL,
      emailVerified: firebaseUser.emailVerified,
    };
  }
  return null;
}

// Email/Password Authentication
export async function signUpWithEmail(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    const firebaseUser = result.user;

    // Send verification email
    await sendEmailVerification(firebaseUser);

    // Create user document + profile atomically. users/{uid} holds sensitive fields (email, tier,
    // verification, activity); profiles/{uid} holds the world-readable displayName/photoURL.
    // Mirrors the signInWithGoogle writeBatch above + initializeUserKeys.
    const userRef = doc(db, 'users', firebaseUser.uid);
    const batch = writeBatch(db);
    batch.set(userRef, {
      email: firebaseUser.email,
      createdAt: serverTimestamp(),
      lastActive: serverTimestamp(),
      emailVerified: false,
      tier: 'standard',
    });
    batch.set(doc(db, PROFILES_COLLECTION, firebaseUser.uid), {
      displayName: firebaseUser.displayName || email.split('@')[0],
      photoURL: firebaseUser.photoURL,
    });
    await batch.commit();

    // Return success - user stays logged in but unverified
    return { success: true };
  } catch (error: unknown) {
    const errorCode = (error as { code?: string })?.code;
    let errorMessage = 'Failed to create account. Please try again.';

    if (errorCode === 'auth/email-already-in-use') {
      errorMessage = 'This email is already registered. Please sign in instead.';
    } else if (errorCode === 'auth/invalid-email') {
      errorMessage = 'Please enter a valid email address.';
    } else if (errorCode === 'auth/weak-password') {
      errorMessage = 'Password should be at least 6 characters.';
    }

    return { success: false, error: errorMessage };
  }
}

export async function signInWithEmail(email: string, password: string): Promise<{ user: User | null; error?: string; needsVerification?: boolean }> {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    const firebaseUser = result.user;

    // Check if email is verified
    if (!firebaseUser.emailVerified) {
      return {
        user: null,
        error: 'Please verify your email address before signing in.',
        needsVerification: true
      };
    }

    // Update user document
    const userRef = doc(db, 'users', firebaseUser.uid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      await setDoc(userRef, {
        lastActive: serverTimestamp(),
        emailVerified: true,
      }, { merge: true });
    }

    return {
      user: {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
        emailVerified: firebaseUser.emailVerified,
      }
    };
  } catch (error: unknown) {
    const firebaseError = error as { code?: string; message?: string };
    const errorCode = firebaseError.code;
    let errorMessage = 'Failed to sign in. Please try again.';

    if (errorCode === 'auth/user-not-found' || errorCode === 'auth/wrong-password' || errorCode === 'auth/invalid-credential') {
      errorMessage = 'Invalid email or password.';
    } else if (errorCode === 'auth/invalid-email') {
      errorMessage = 'Please enter a valid email address.';
    } else if (errorCode === 'auth/too-many-requests') {
      errorMessage = 'Too many failed attempts. Please try again later.';
    }

    return { user: null, error: errorMessage };
  }
}

export async function sendPasswordReset(email: string): Promise<{ success: boolean; error?: string }> {
  try {
    await sendPasswordResetEmail(auth, email);
    return { success: true };
  } catch (error: unknown) {
    const errorCode = (error as { code?: string })?.code;
    let errorMessage = 'Failed to send reset email. Please try again.';

    if (errorCode === 'auth/user-not-found') {
      // Don't reveal if email exists or not for security
      return { success: true };
    } else if (errorCode === 'auth/invalid-email') {
      errorMessage = 'Please enter a valid email address.';
    }

    return { success: false, error: errorMessage };
  }
}

export async function resendVerificationEmail(): Promise<{ success: boolean; error?: string }> {
  try {
    const user = auth.currentUser;
    if (user && !user.emailVerified) {
      await sendEmailVerification(user);
      return { success: true };
    }
    return { success: false, error: 'No user to verify.' };
  } catch (error) {
    return { success: false, error: 'Failed to send verification email.' };
  }
}

// Update user's display name in Firestore and Firebase Auth
export async function updateUserDisplayName(userId: string, displayName: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Firestore-first: atomically write the world-readable profile name + stamp activity on the
    // user doc, THEN sync Firebase Auth. If the batch fails we bail before touching Auth, so the
    // cross-user-visible name and the self-UI name can't drift apart. displayName now lives ONLY in
    // profiles/{uid} (moved out of users/{uid}); lastActive stays on the user doc. Mirrors Piece B.
    const userRef = doc(db, 'users', userId);
    const profileRef = doc(db, PROFILES_COLLECTION, userId);
    const batch = writeBatch(db);
    batch.set(profileRef, { displayName }, { merge: true });
    batch.set(userRef, { lastActive: serverTimestamp() }, { merge: true });
    await batch.commit();

    // Also update Firebase Auth profile so it persists on refresh
    const currentUser = auth.currentUser;
    if (currentUser) {
      await updateProfile(currentUser, { displayName });
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating display name:', error);
    return { success: false, error: 'Failed to update name. Please try again.' };
  }
}

// Category-strip collapse preference, per space (personal or a workspace id).
// Stored on the user's own doc under catCollapsed[spaceKey]. setDoc with merge
// deep-merges the map, so one space's toggle never overwrites another's.
// Mirrors the updateUserDisplayName pattern above.
export async function getCategoryCollapsed(userId: string): Promise<Record<string, boolean>> {
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    return (snap.data()?.catCollapsed as Record<string, boolean> | undefined) ?? {};
  } catch (error) {
    console.error('Error loading category collapse preference:', error);
    return {};
  }
}

export async function setCategoryCollapsed(userId: string, spaceKey: string, collapsed: boolean): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await setDoc(userRef, { catCollapsed: { [spaceKey]: collapsed } }, { merge: true });
  } catch (error) {
    console.error('Error saving category collapse preference:', error);
  }
}

// Drop sort + manual-reorder preferences, per space (personal or a workspace id).
// Stored on the user's own doc under dropSortMode[spaceKey] and dropOrder[spaceKey].
// setDoc with merge deep-merges each map, so one space never overwrites another.
// Mirrors the getCategoryCollapsed/setCategoryCollapsed pattern above.
export type DropSortMode = 'manual' | 'newest' | 'name' | 'size' | 'expiry';

export async function getDropSortPrefs(
  userId: string
): Promise<{ mode: Record<string, string>; order: Record<string, string[]> }> {
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    const data = snap.data() ?? {};
    return {
      mode: (data.dropSortMode as Record<string, string> | undefined) ?? {},
      order: (data.dropOrder as Record<string, string[]> | undefined) ?? {},
    };
  } catch (error) {
    console.error('Error loading drop sort preferences:', error);
    return { mode: {}, order: {} };
  }
}

export async function setDropSortMode(userId: string, spaceKey: string, mode: DropSortMode): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await setDoc(userRef, { dropSortMode: { [spaceKey]: mode } }, { merge: true });
  } catch (error) {
    console.error('Error saving drop sort mode:', error);
  }
}

export async function setDropOrder(userId: string, spaceKey: string, order: string[]): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await setDoc(userRef, { dropOrder: { [spaceKey]: order } }, { merge: true });
  } catch (error) {
    console.error('Error saving drop order:', error);
  }
}

// Get the auth provider for the current user
export function getAuthProvider(): 'password' | 'google.com' | null {
  const user = auth.currentUser;
  if (!user) return null;
  if (user.providerData.some((provider) => provider.providerId === 'password')) return 'password';
  if (user.providerData.some((provider) => provider.providerId === 'google.com')) return 'google.com';
  return null;
}

// Re-authenticate user (required for account deletion)
export async function reauthenticateUser(password?: string): Promise<{ success: boolean; error?: string }> {
  const user = auth.currentUser;
  if (!user) return { success: false, error: 'No user logged in' };

  const provider = getAuthProvider();

  try {
    if (provider === 'password' && password) {
      const credential = EmailAuthProvider.credential(user.email!, password);
      await reauthenticateWithCredential(user, credential);
      return { success: true };
    } else if (provider === 'google.com') {
      const googleProvider = new GoogleAuthProvider();
      await reauthenticateWithPopup(user, googleProvider);
      return { success: true };
    }
    return { success: false, error: 'Unsupported authentication method' };
  } catch (error: unknown) {
    const errorCode = (error as { code?: string })?.code;
    let errorMessage = 'Re-authentication failed';
    if (errorCode === 'auth/wrong-password' || errorCode === 'auth/invalid-credential') {
      errorMessage = 'Incorrect password';
    } else if (errorCode === 'auth/popup-closed-by-user') {
      errorMessage = 'Authentication cancelled';
    }
    return { success: false, error: errorMessage };
  }
}
