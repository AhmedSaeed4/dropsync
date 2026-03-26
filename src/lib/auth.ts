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
  EmailAuthProvider
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
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
      await setDoc(userRef, {
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        photoURL: firebaseUser.photoURL,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
      });
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

    // Create user document in Firestore
    const userRef = doc(db, 'users', firebaseUser.uid);
    await setDoc(userRef, {
      email: firebaseUser.email,
      displayName: firebaseUser.displayName || email.split('@')[0],
      photoURL: firebaseUser.photoURL,
      createdAt: serverTimestamp(),
      lastActive: serverTimestamp(),
      emailVerified: false,
    });

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

// Update user's display name in Firestore
export async function updateUserDisplayName(userId: string, displayName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const userRef = doc(db, 'users', userId);
    await setDoc(userRef, {
      displayName,
      lastActive: serverTimestamp(),
    }, { merge: true });
    return { success: true };
  } catch (error) {
    console.error('Error updating display name:', error);
    return { success: false, error: 'Failed to update name. Please try again.' };
  }
}

// Get the auth provider for the current user
export function getAuthProvider(): 'password' | 'google.com' | null {
  const user = auth.currentUser;
  if (!user) return null;
  return user.providerData[0]?.providerId as 'password' | 'google.com' | null;
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