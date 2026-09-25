'use client';

import { useState, useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { onAuthChange, signInWithGoogle, signOut, signUpWithEmail, signInWithEmail, sendPasswordReset, resendVerificationEmail, getAuthProvider, reauthenticateUser } from '@/lib/auth';
import { User } from '@/types';
import { getArchiveTaskManager } from '@/lib/archiveTaskManager';
import { tryAuthChange } from '@/lib/archiveJobLock';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ error?: string; success?: boolean }>;
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  resendVerification: () => Promise<{ success: boolean; error?: string }>;
  signOutUser: () => Promise<boolean>;
  authActionNotice: string | null;
  clearAuthActionNotice: () => void;
  getProvider: () => 'password' | 'google.com' | null;
  reauthenticate: (password?: string) => Promise<{ success: boolean; error?: string }>;
  updateDisplayName: (name: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authActionNotice, setAuthActionNotice] = useState<string | null>(null);
  const currentUidRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthChange((authUser) => {
      if (authUser) {
        if (currentUidRef.current !== authUser.uid) getArchiveTaskManager().markRecoveryPending(authUser.uid);
        currentUidRef.current = authUser.uid;
        // Add provider detection
        const providerId = getAuthProvider() ?? undefined;
        setUser({ ...authUser, providerId });
      } else {
        currentUidRef.current = null;
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleSignIn = async () => {
    let signed: User | null = null;
    if (user && !(await tryAuthChange(user.uid, async () => { signed = await signInWithGoogle(); }))) {
      setAuthActionNotice('Finish the archive or its cleanup before switching accounts.');
      return;
    }
    if (!user) signed = await signInWithGoogle();
    if (signed) {
      setUser({ ...signed, providerId: getAuthProvider() ?? undefined });
    }
  };

  const handleSignOut = async () => {
    const accepted = await tryAuthChange(user?.uid ?? null, signOut);
    if (!accepted) {
      setAuthActionNotice('Finish the archive or its cleanup before signing out.');
      return false;
    }
    setUser(null);
    return true;
  };

  const handleSignUp = async (email: string, password: string) => {
    let result: Awaited<ReturnType<typeof signUpWithEmail>> | null = null;
    if (user && !(await tryAuthChange(user.uid, async () => { result = await signUpWithEmail(email, password); }))) {
      setAuthActionNotice('Finish the archive or its cleanup before switching accounts.');
      return { error: 'Finish the archive or its cleanup before switching accounts.' };
    }
    if (!user) result = await signUpWithEmail(email, password);
    if (!result) return { error: 'Sign-up was not completed.' };
    return { error: result.error, success: result.success };
  };

  const handleSignInWithEmail = async (email: string, password: string) => {
    let result: Awaited<ReturnType<typeof signInWithEmail>> | null = null;
    if (user && !(await tryAuthChange(user.uid, async () => { result = await signInWithEmail(email, password); }))) {
      setAuthActionNotice('Finish the archive or its cleanup before switching accounts.');
      return { error: 'Finish the archive or its cleanup before switching accounts.' };
    }
    if (!user) result = await signInWithEmail(email, password);
    if (!result) return { error: 'Sign-in was not completed.' };
    if (result.user) {
      setUser({ ...result.user, providerId: getAuthProvider() ?? undefined });
    }
    return { error: result.error, needsVerification: result.needsVerification };
  };

  const handleResetPassword = async (email: string) => {
    return await sendPasswordReset(email);
  };

  const handleResendVerification = async () => {
    return await resendVerificationEmail();
  };

  const handleUpdateDisplayName = (name: string) => {
    if (user) {
      setUser({ ...user, displayName: name });
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn: handleSignIn,
        signUp: handleSignUp,
        signInWithEmail: handleSignInWithEmail,
        resetPassword: handleResetPassword,
        resendVerification: handleResendVerification,
        signOutUser: handleSignOut,
        authActionNotice,
        clearAuthActionNotice: () => setAuthActionNotice(null),
        getProvider: getAuthProvider,
        reauthenticate: reauthenticateUser,
        updateDisplayName: handleUpdateDisplayName,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
