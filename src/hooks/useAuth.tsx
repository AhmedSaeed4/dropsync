'use client';

import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { onAuthChange, signInWithGoogle, signOut, signUpWithEmail, signInWithEmail, sendPasswordReset, resendVerificationEmail, getAuthProvider, reauthenticateUser } from '@/lib/auth';
import { auth } from '@/lib/firebase';
import { User } from '@/types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ error?: string; success?: boolean }>;
  signInWithEmail: (email: string, password: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  resendVerification: () => Promise<{ success: boolean; error?: string }>;
  signOutUser: () => Promise<void>;
  getProvider: () => 'password' | 'google.com' | null;
  reauthenticate: (password?: string) => Promise<{ success: boolean; error?: string }>;
  updateDisplayName: (name: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthChange((authUser) => {
      if (authUser) {
        // Add provider detection
        const providerId = auth.currentUser?.providerData[0]?.providerId as 'password' | 'google.com' | undefined;
        setUser({ ...authUser, providerId });
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    const user = await signInWithGoogle();
    if (user) {
      setUser(user);
    }
    setLoading(false);
  };

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
  };

  const handleSignUp = async (email: string, password: string) => {
    const result = await signUpWithEmail(email, password);
    return { error: result.error, success: result.success };
  };

  const handleSignInWithEmail = async (email: string, password: string) => {
    const result = await signInWithEmail(email, password);
    if (result.user) {
      setUser(result.user);
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