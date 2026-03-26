'use client';

import { useState, useEffect } from 'react';
import { User } from '@/types';
import { previewAccountDeletion, deleteAccount, DeletionPreview, SelectedOwners } from '@/lib/accountDeletion';
import { updateUserDisplayName } from '@/lib/auth';

interface SettingsModalProps {
  user: User;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onReauthenticate: (password?: string) => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  onDeleted: () => void;
  onNameUpdate?: (name: string) => void;
  theme?: 'light' | 'dark' | 'minimal';
}

type Step = 'main' | 'password-reset' | 'delete-preview' | 'delete-confirm' | 'deleting' | 'deleted';

export function SettingsModal({
  user,
  onResetPassword,
  onReauthenticate,
  onClose,
  onDeleted,
  onNameUpdate,
  theme = 'light',
}: SettingsModalProps) {
  const [step, setStep] = useState<Step>('main');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Profile name state
  const [profileName, setProfileName] = useState(user.displayName || '');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  // Password reset state
  const [resetLoading, setResetLoading] = useState(false);

  // Account deletion state
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreview | null>(null);
  const [password, setPassword] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [selectedOwners, setSelectedOwners] = useState<SelectedOwners>({});

  const isPasswordProvider = user.providerId === 'password';
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  // Theme styling helper
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        overlayBg: 'bg-black/30 backdrop-blur-sm',
        bgColor: 'bg-[#D4D8C8]',
        borderColor: 'border-[#1A1A1A]/20',
        headerBg: 'bg-[#1A1A1A]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        inputBg: 'bg-[#C5C9B8]',
        buttonSecondary: 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]',
        buttonPrimary: 'bg-[#1A1A1A] hover:bg-[#333] text-white',
        buttonDanger: 'bg-red-500 hover:bg-red-600 text-white',
        roundedClass: 'rounded-lg',
      };
    }
    return {
      overlayBg: 'bg-black/70 backdrop-blur-sm',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      headerBg: 'bg-[#FF5A47]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      buttonSecondary: isDark ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]',
      buttonPrimary: 'bg-[#1A1A1A] hover:bg-[#333] text-white',
      buttonDanger: 'bg-red-500 hover:bg-red-600 text-white',
      roundedClass: '',
    };
  };

  const tc = getThemeColors();

  // Load deletion preview
  useEffect(() => {
    if (step === 'delete-preview' && !deletionPreview) {
      previewAccountDeletion(user.uid).then(setDeletionPreview);
    }
  }, [step, user.uid, deletionPreview]);

  const handlePasswordReset = async () => {
    if (!user.email) return;
    setResetLoading(true);
    setError(null);

    const result = await onResetPassword(user.email);
    setResetLoading(false);

    if (result.success) {
      setSuccess('Password reset email sent!');
      setTimeout(() => setSuccess(null), 3000);
    } else {
      setError(result.error || 'Failed to send reset email');
    }
  };

  const handleUpdateProfileName = async () => {
    if (!profileName.trim()) return;
    setProfileLoading(true);
    setProfileSuccess(null);
    setError(null);

    const result = await updateUserDisplayName(user.uid, profileName.trim());
    setProfileLoading(false);

    if (result.success) {
      setProfileSuccess('Name updated successfully!');
      if (onNameUpdate) {
        onNameUpdate(profileName.trim());
      }
      setTimeout(() => setProfileSuccess(null), 3000);
    } else {
      setError(result.error || 'Failed to update name');
    }
  };

  const handleStartDeletion = () => {
    setError(null);
    setStep('delete-preview');
  };

  const handleConfirmDeletion = async () => {
    if (confirmEmail !== user.email) {
      setError('Email address does not match');
      return;
    }

    if (isPasswordProvider && !password) {
      setError('Please enter your password');
      return;
    }

    // Validate that all workspaces with members have selected owners
    if (deletionPreview) {
      const hasUnselectedWorkspace = deletionPreview.workspacesOwned.some(
        w => w.members.length > 0 && !selectedOwners[w.id]
      );
      if (hasUnselectedWorkspace) {
        setError('Please select a new owner for each workspace');
        return;
      }
    }

    setLoading(true);
    setError(null);
    setStep('deleting');

    // Re-authenticate first
    const reauthResult = await onReauthenticate(password);
    if (!reauthResult.success) {
      setError(reauthResult.error || 'Re-authentication failed');
      setStep('delete-confirm');
      setLoading(false);
      return;
    }

    // Delete account
    const deleteResult = await deleteAccount(user.uid, selectedOwners);
    setLoading(false);

    if (deleteResult.success) {
      setStep('deleted');
      setTimeout(() => {
        onDeleted();
      }, 2000);
    } else {
      setError(deleteResult.error || 'Failed to delete account');
      setStep('delete-confirm');
    }
  };

  const renderMainSettings = () => (
    <div className="p-6">
      {/* Profile Section */}
      <div className="mb-6">
        <h3 className={`text-sm font-semibold mb-3 ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${tc.textColor}`}>
          {isMinimal ? 'Profile' : 'PROFILE'}
        </h3>
        <p className={`text-xs mb-3 ${tc.textMuted}`}>
          {isMinimal ? 'Set your display name for workspace drops' : 'SET_YOUR_DISPLAY_NAME_FOR_WORKSPACE_DROPS'}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={user.email?.split('@')[0] || 'Your name'}
            className={`flex-1 px-4 py-3 ${tc.inputBg} border ${tc.borderColor} ${tc.roundedClass} ${tc.textColor} text-xs focus:outline-none focus:ring-1 focus:ring-[#FF5A47]`}
          />
          <button
            onClick={handleUpdateProfileName}
            disabled={profileLoading || !profileName.trim()}
            className={`px-4 py-3 ${tc.buttonPrimary} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors disabled:opacity-50`}
          >
            {profileLoading ? '...' : isMinimal ? 'Save' : 'SAVE'}
          </button>
        </div>
        {profileSuccess && (
          <div className={`mt-3 p-3 ${isMinimal ? 'bg-[#1A1A1A]/5' : isDark ? 'bg-green-500/10' : 'bg-green-50'} ${tc.roundedClass}`}>
            <p className={`text-xs ${isMinimal ? 'text-[#1A1A1A]' : 'text-green-600'}`}>
              {profileSuccess}
            </p>
          </div>
        )}
      </div>

      {/* Password Reset Section - Only for password users */}
      {isPasswordProvider && (
        <div className="mb-6">
          <h3 className={`text-sm font-semibold mb-3 ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${tc.textColor}`}>
            {isMinimal ? 'Password' : 'PASSWORD/RESET'}
          </h3>
          <p className={`text-xs mb-4 ${tc.textMuted}`}>
            Send a password reset email to {user.email}
          </p>
          {success && (
            <div className={`mb-4 p-3 ${isMinimal ? 'bg-[#1A1A1A]/5' : isDark ? 'bg-green-500/10' : 'bg-green-50'} ${tc.roundedClass}`}>
              <p className={`text-xs ${isMinimal ? 'text-[#1A1A1A]' : 'text-green-600'}`}>
                {success}
              </p>
            </div>
          )}

          <button
            onClick={handlePasswordReset}
            disabled={resetLoading}
            className={`w-full py-3 px-4 ${tc.buttonPrimary} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors disabled:opacity-50`}
          >
            {resetLoading ? 'Sending...' : isMinimal ? 'Send Reset Email' : 'SEND_RESET_EMAIL'}
          </button>
        </div>
      )}

      {/* Danger Zone */}
      <div className={`pt-6 ${isPasswordProvider ? 'border-t ' + tc.borderColor : ''}`}>
        <h3 className={`text-sm font-semibold mb-3 ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} text-red-500`}>
          {isMinimal ? 'Danger Zone' : 'DANGER'}
        </h3>
        <p className={`text-xs mb-4 ${tc.textMuted}`}>
          Permanently delete your account.
        </p>
        <button
          onClick={handleStartDeletion}
          className={`w-full py-3 px-4 ${tc.buttonDanger} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors`}
        >
          {isMinimal ? 'Delete Account' : 'DELETE'}
        </button>
      </div>

      {error && (
        <div className={`mt-4 p-3 ${isMinimal ? 'bg-red-500/10' : isDark ? 'bg-red-500/10' : 'bg-red-50'} ${tc.roundedClass}`}>
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}
    </div>
  );

  const renderDeletePreview = () => (
    <div className="p-6">
      {!deletionPreview ? (
        <div className="flex justify-center py-8">
          <div className={`w-6 h-6 border-2 ${isMinimal ? 'border-[#1A1A1A]/30 border-t-[#1A1A1A]' : isDark ? 'border-white/30 border-t-white' : 'border-[#1A1A1A]/30 border-t-[#1A1A1A]'} animate-spin rounded-full`} />
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h3 className={`text-sm font-semibold mb-4 ${tc.textColor}`}>
              {isMinimal ? 'The following will be deleted:' : 'THE_FOLLOWING_WILL_BE_DELETED:'}
            </h3>

            <ul className={`text-xs space-y-2 ${tc.textMuted}`}>
              <li className="flex justify-between">
                <span>{isMinimal ? 'Personal drops' : 'PERSONAL_DROPS'}</span>
                <span className={tc.textColor}>{deletionPreview.personalDrops}</span>
              </li>
              {deletionPreview.workspacesOwned.length > 0 && (
                <li>
                  <div className="mb-1">{isMinimal ? 'Workspaces (you own):' : 'WORKSPACES_(YOU_OWN):'}</div>
                  <ul className="ml-4 space-y-2">
                    {deletionPreview.workspacesOwned.map((w) => (
                      <li key={w.id}>
                        <div className="flex justify-between items-center">
                          <span>{w.name}</span>
                          {w.members.length > 0 ? (
                            <select
                              value={selectedOwners[w.id] || ''}
                              onChange={(e) => {
                                setSelectedOwners(prev => ({
                                  ...prev,
                                  [w.id]: e.target.value
                                }));
                              }}
                              className={`ml-2 px-2 py-1 text-xs ${tc.inputBg} border ${tc.borderColor} ${tc.roundedClass} ${tc.textColor} focus:outline-none`}
                            >
                              <option value="" disabled>Select new owner</option>
                              {w.members.map((m) => (
                                <option key={m.uid} value={m.uid}>
                                  {m.displayName || m.email || m.uid}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={`${tc.textColor} text-red-500`}>
                              {isMinimal ? 'Will be deleted' : 'WILL_BE_DELETED'}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              {deletionPreview.workspacesMemberOf.length > 0 && (
                <li>
                  <div className="mb-1">{isMinimal ? 'Workspaces (member):' : 'WORKSPACES_(MEMBER):'}</div>
                  <ul className="ml-4 space-y-1">
                    {deletionPreview.workspacesMemberOf.map((w) => (
                      <li key={w.id} className="flex justify-between">
                        <span>{w.name}</span>
                        <span className={tc.textColor}>{isMinimal ? 'Leave' : 'LEAVE'}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </div>

          {/* Only show this message if there are workspaces that will survive */}
          {(deletionPreview.workspacesOwned.some(w => w.members.length > 0) || deletionPreview.workspacesMemberOf.length > 0) && (
            <div className={`p-3 mb-4 ${isMinimal ? 'bg-[#1A1A1A]/5' : isDark ? 'bg-yellow-500/10' : 'bg-yellow-50'} ${tc.roundedClass}`}>
              <p className={`text-xs ${isMinimal ? 'text-[#1A1A1A]' : 'text-yellow-600'}`}>
                {isMinimal
                  ? 'Drops in surviving workspaces will remain.'
                  : 'DROPS_IN_SURVIVING_WORKSPACES_PRESERVED.'}
              </p>
            </div>
          )}

          {/* Show warning if user will lose workspace drops */}
          {deletionPreview.workspacesOwned.some(w => w.members.length === 0) && (
            <div className={`p-3 mb-4 ${isMinimal ? 'bg-red-500/10' : isDark ? 'bg-red-500/10' : 'bg-red-50'} ${tc.roundedClass}`}>
              <p className={`text-xs ${isMinimal ? 'text-[#1A1A1A]' : 'text-red-600'}`}>
                {isMinimal
                  ? 'Empty workspaces and their drops will be deleted.'
                  : 'EMPTY_WORKSPACES_AND_DROPS_DELETED.'}
              </p>
            </div>
          )}

          {/* Validation error if workspaces with members don't have selected owners */}
          {deletionPreview.workspacesOwned.some(w => w.members.length > 0 && !selectedOwners[w.id]) && (
            <div className={`p-3 mb-4 ${isMinimal ? 'bg-red-500/10' : isDark ? 'bg-red-500/10' : 'bg-red-50'} ${tc.roundedClass}`}>
              <p className={`text-xs text-red-500`}>
                {isMinimal
                  ? 'Please select a new owner for each workspace.'
                  : 'SELECT_NEW_OWNER_FOR_EACH_WORKSPACE.'}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setStep('main')}
              className={`flex-1 py-3 px-4 ${tc.buttonSecondary} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors`}
            >
              {isMinimal ? 'Cancel' : 'CANCEL'}
            </button>
            <button
              onClick={() => setStep('delete-confirm')}
              disabled={deletionPreview.workspacesOwned.some(w => w.members.length > 0 && !selectedOwners[w.id])}
              className={`flex-1 py-3 px-4 ${tc.buttonDanger} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isMinimal ? 'Continue' : 'CONTINUE'}
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderDeleteConfirm = () => (
    <div className="p-6">
      <div className={`p-3 mb-4 ${isMinimal ? 'bg-red-500/10' : isDark ? 'bg-red-500/10' : 'bg-red-50'} ${tc.roundedClass}`}>
        <p className={`text-xs ${isMinimal ? 'text-[#1A1A1A]' : 'text-red-600'}`}>
          {isMinimal ? 'This action cannot be undone.' : 'THIS_ACTION_CANNOT_BE_UNDONE.'}
        </p>
      </div>

      {/* Email confirmation */}
      <div className="mb-4">
        <label className={`block text-xs mb-2 ${tc.textMuted}`}>
          {isMinimal ? 'Type your email to confirm:' : 'TYPE_YOUR_EMAIL_TO_CONFIRM:'}
        </label>
        <input
          type="email"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder={user.email || ''}
          className={`w-full px-4 py-3 ${tc.inputBg} border ${tc.borderColor} ${tc.roundedClass} ${tc.textColor} text-xs focus:outline-none focus:ring-1 focus:ring-[#FF5A47]`}
        />
      </div>

      {/* Password for password users */}
      {isPasswordProvider && (
        <div className="mb-4">
          <label className={`block text-xs mb-2 ${tc.textMuted}`}>
            {isMinimal ? 'Enter your password:' : 'ENTER_YOUR_PASSWORD:'}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className={`w-full px-4 py-3 ${tc.inputBg} border ${tc.borderColor} ${tc.roundedClass} ${tc.textColor} text-xs focus:outline-none focus:ring-1 focus:ring-[#FF5A47]`}
          />
        </div>
      )}

      {!isPasswordProvider && (
        <p className={`text-xs mb-4 ${tc.textMuted}`}>
          {isMinimal
            ? 'A Google sign-in popup will appear to confirm your identity.'
            : 'A_GOOGLE_SIGN-IN_POPUP_WILL_APPEAR_TO_CONFIRM_YOUR_IDENTITY.'}
        </p>
      )}

      {error && (
        <div className={`mb-4 p-3 ${isMinimal ? 'bg-red-500/10' : isDark ? 'bg-red-500/10' : 'bg-red-50'} ${tc.roundedClass}`}>
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setStep('delete-preview')}
          disabled={loading}
          className={`flex-1 py-3 px-4 ${tc.buttonSecondary} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors disabled:opacity-50`}
        >
          {isMinimal ? 'Back' : 'BACK'}
        </button>
        <button
          onClick={handleConfirmDeletion}
          disabled={loading}
          className={`flex-1 py-3 px-4 ${tc.buttonDanger} ${tc.roundedClass} text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} transition-colors disabled:opacity-50`}
        >
          {loading ? 'Deleting...' : isMinimal ? 'Delete My Account' : 'DELETE_MY_ACCOUNT'}
        </button>
      </div>
    </div>
  );

  const renderDeleting = () => (
    <div className="p-8 flex flex-col items-center justify-center">
      <div className={`w-8 h-8 border-2 ${isMinimal ? 'border-[#1A1A1A]/30 border-t-[#1A1A1A]' : isDark ? 'border-white/30 border-t-white' : 'border-[#1A1A1A]/30 border-t-[#1A1A1A]'} animate-spin rounded-full mb-4`} />
      <p className={`text-sm ${tc.textColor}`}>
        {isMinimal ? 'Deleting your account...' : 'DELETING_YOUR_ACCOUNT...'}
      </p>
    </div>
  );

  const renderDeleted = () => (
    <div className="p-8 flex flex-col items-center justify-center">
      <div className={`w-12 h-12 ${isMinimal ? 'bg-[#1A1A1A]/5' : 'bg-green-500/10'} rounded-full flex items-center justify-center mb-4`}>
        <svg className={`w-6 h-6 ${isMinimal ? 'text-[#1A1A1A]' : 'text-green-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className={`text-sm ${tc.textColor}`}>
        {isMinimal ? 'Account deleted successfully' : 'ACCOUNT_DELETED_SUCCESSFULLY'}
      </p>
    </div>
  );

  return (
    <div className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`relative w-full max-w-md ${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} max-h-[90vh] overflow-y-auto`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {step === 'deleted' ? (isMinimal ? 'Goodbye' : 'GOODBYE') : isMinimal ? 'Settings' : 'SETTINGS'}
          </h2>
          {step !== 'deleting' && step !== 'deleted' && (
            <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        {step === 'main' && renderMainSettings()}
        {step === 'password-reset' && renderMainSettings()}
        {step === 'delete-preview' && renderDeletePreview()}
        {step === 'delete-confirm' && renderDeleteConfirm()}
        {step === 'deleting' && renderDeleting()}
        {step === 'deleted' && renderDeleted()}
      </div>
    </div>
  );
}