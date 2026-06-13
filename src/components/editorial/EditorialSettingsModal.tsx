'use client';

import { useState, useEffect } from 'react';
import { User } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { getEditorialThemeColors } from './editorialTheme';
import { previewAccountDeletion, deleteAccount, DeletionPreview, SelectedOwners } from '@/lib/accountDeletion';
import { updateUserDisplayName } from '@/lib/auth';
import { isNotificationsSupported, isIOSSafari } from '@/lib/notifications';

interface EditorialSettingsModalProps {
  user: User;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onReauthenticate: (password?: string) => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  onDeleted: () => void;
  onSignOut: () => void;
  onNameUpdate?: (name: string) => void;
  onLayoutChange?: (layout: 'classic' | 'editorial') => void;
  layoutMode?: 'classic' | 'editorial';
  theme?: 'light' | 'dark' | 'minimal';
  notifPermission?: NotificationPermission;
  notifMuted?: boolean;
  onToggleNotifications?: () => void;
}

type Step = 'main' | 'delete-preview' | 'delete-confirm' | 'deleting' | 'deleted';

export function EditorialSettingsModal({
  user,
  onResetPassword,
  onReauthenticate,
  onClose,
  onDeleted,
  onSignOut,
  onNameUpdate,
  onLayoutChange,
  layoutMode = 'classic',
  theme = 'light',
  notifPermission = 'default',
  notifMuted = false,
  onToggleNotifications,
}: EditorialSettingsModalProps) {
  useBodyScrollLock();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'appearance'>('general');
  const [step, setStep] = useState<Step>('main');

  // Profile name state
  const [profileName, setProfileName] = useState(user.displayName || '');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  // Account deletion state
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreview | null>(null);
  const [password, setPassword] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [selectedOwners, setSelectedOwners] = useState<SelectedOwners>({});

  const tc = getEditorialThemeColors(theme);
  const isPasswordProvider = user.providerId === 'password';

  // Notifications state (foreground-only browser alerts)
  const notifEnabled = notifPermission === 'granted' && !notifMuted;
  const notifSupported = isNotificationsSupported() && !isIOSSafari();
  const notifDisabled = !notifSupported || notifPermission === 'denied';
  const notifHint = !notifSupported
    ? 'Not supported on this device.'
    : notifPermission === 'denied'
      ? 'Blocked — enable notifications in your browser site settings.'
      : notifPermission === 'default'
        ? 'Turn on to get desktop alerts for new messages.'
        : notifMuted
          ? 'Muted — alerts are off.'
          : 'Desktop alerts for new group chat messages.';

  // Load deletion preview
  useEffect(() => {
    if (step === 'delete-preview' && !deletionPreview) {
      previewAccountDeletion(user.uid).then(setDeletionPreview);
    }
  }, [step, user.uid, deletionPreview]);

  const handlePasswordReset = async () => {
    if (!user.email) return;
    setLoading(true);
    const result = await onResetPassword(user.email);
    if (result.success) {
      setSuccess('Password reset email sent!');
    } else if (result.error) {
      setError(result.error);
    }
    setLoading(false);
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

    const reauthResult = await onReauthenticate(password);
    if (!reauthResult.success) {
      setError(reauthResult.error || 'Re-authentication failed');
      setStep('delete-confirm');
      setLoading(false);
      return;
    }

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

  const renderDeletePreview = () => (
    <div className="p-5 space-y-4">
      <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm`}>Delete Account</h3>
      <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
        This action is permanent. Here&apos;s what will happen:
      </p>

      {deletionPreview && (
        <div className="space-y-3">
          <div className={`p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
            <p className={`text-xs font-medium ${tc.text} ${tc.fontClass} mb-1`}>
              {deletionPreview.personalDrops} personal drop{deletionPreview.personalDrops !== 1 ? 's' : ''} will be deleted
            </p>
          </div>

          {deletionPreview.workspacesOwned.length > 0 && (
            <div className="space-y-2">
              <p className={`text-xs font-medium ${tc.text} ${tc.fontClass}`}>
                Workspaces you own:
              </p>
              {deletionPreview.workspacesOwned.map((w) => (
                <div key={w.id} className={`p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
                  <p className={`text-xs font-medium ${tc.text} ${tc.fontClass}`}>{w.name}</p>
                  <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                    {w.members.length} member{w.members.length !== 1 ? 's' : ''}
                  </p>
                  {w.members.length > 0 && (
                    <select
                      value={selectedOwners[w.id] || ''}
                      onChange={(e) => setSelectedOwners(prev => ({ ...prev, [w.id]: e.target.value }))}
                      className={`mt-2 w-full px-3 py-2 text-xs border ${tc.border} ${tc.bg} ${tc.text} rounded-lg ${tc.fontClass}`}
                    >
                      <option value="">Select new owner...</option>
                      {w.members.map((m) => (
                        <option key={m.uid} value={m.uid}>{m.email}</option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={() => { setStep('main'); setError(null); }}
          className={`flex-1 py-2.5 text-sm ${tc.fontClass} border ${tc.border} ${tc.text} rounded-lg hover:border-[#1a1a1a] transition-colors`}
        >
          Cancel
        </button>
        <button
          onClick={() => setStep('delete-confirm')}
          className="flex-1 py-2.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );

  const renderDeleteConfirm = () => (
    <div className="p-5 space-y-4">
      <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm`}>Confirm Deletion</h3>
      <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
        Type your email <span className={`font-medium ${tc.text}`}>{user.email}</span> to confirm.
      </p>

      <input
        type="email"
        value={confirmEmail}
        onChange={(e) => setConfirmEmail(e.target.value)}
        placeholder="Confirm email"
        className={`w-full px-4 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} rounded-lg focus:outline-none focus:border-red-400 ${tc.fontClass}`}
      />

      {isPasswordProvider && (
        <div>
          <p className={`text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Enter your password to confirm:</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className={`w-full px-4 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} rounded-lg focus:outline-none focus:border-red-400 ${tc.fontClass}`}
          />
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={() => { setStep('delete-preview'); setError(null); }}
          className={`flex-1 py-2.5 text-sm ${tc.fontClass} border ${tc.border} ${tc.text} rounded-lg hover:border-[#1a1a1a] transition-colors`}
        >
          Back
        </button>
        <button
          onClick={handleConfirmDeletion}
          disabled={loading}
          className="flex-1 py-2.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
        >
          {loading ? 'Deleting...' : 'Delete Account'}
        </button>
      </div>
    </div>
  );

  const renderDeleting = () => (
    <div className="p-5 flex flex-col items-center justify-center gap-3">
      <div className="w-6 h-6 border-2 border-red-400 border-t-transparent animate-spin rounded-full" />
      <p className={`text-sm ${tc.text} ${tc.fontClass}`}>Deleting your account...</p>
    </div>
  );

  const renderDeleted = () => (
    <div className="p-5 flex flex-col items-center justify-center gap-3">
      <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <p className={`text-sm ${tc.text} ${tc.fontClass}`}>Account deleted successfully</p>
    </div>
  );

  if (step === 'delete-preview') return (
    <div className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 modal-fade-in" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col modal-card-in`}>
        {renderDeletePreview()}
      </div>
    </div>
  );

  if (step === 'delete-confirm') return (
    <div className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 modal-fade-in" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col modal-card-in`}>
        {renderDeleteConfirm()}
      </div>
    </div>
  );

  if (step === 'deleting' || step === 'deleted') return (
    <div className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 modal-fade-in">
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col modal-card-in`}>
        {step === 'deleting' ? renderDeleting() : renderDeleted()}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 modal-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col modal-card-in`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Settings</h2>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b ${tc.border}`}>
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 py-3 text-sm ${tc.fontClass} transition-colors border-b-2 ${
              activeTab === 'general'
                ? `${tc.text} border-[#1a1a1a]`
                : `${tc.muted} border-transparent hover:${tc.text}`
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('appearance')}
            className={`flex-1 py-3 text-sm ${tc.fontClass} transition-colors border-b-2 ${
              activeTab === 'appearance'
                ? `${tc.text} border-[#1a1a1a]`
                : `${tc.muted} border-transparent hover:${tc.text}`
            }`}
          >
            Appearance
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className={`bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 mb-4 ${tc.fontClass}`}>
              {error}
            </div>
          )}

          {success && (
            <div className={`bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-600 mb-4 ${tc.fontClass}`}>
              {success}
            </div>
          )}

          {activeTab === 'general' ? (
            <div className="space-y-5">
              {/* Account Info */}
              <div>
                <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Account</h3>
                <div className={`p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
                  <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Email</label>
                  <p className={`${tc.text} text-sm ${tc.fontClass}`}>{user.email}</p>
                </div>
              </div>

              {/* Profile Name */}
              <div>
                <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Profile</h3>
                <p className={`text-xs ${tc.muted} ${tc.fontClass} mb-2`}>Set your display name for workspace drops</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder={user.email?.split('@')[0] || 'Your name'}
                    className={`flex-1 px-3 py-2.5 text-sm border ${tc.border} ${tc.bg} ${tc.text} rounded-lg focus:outline-none focus:border-[#1a1a1a] ${tc.fontClass}`}
                  />
                  <button
                    onClick={handleUpdateProfileName}
                    disabled={profileLoading || !profileName.trim()}
                    className={`px-4 py-2.5 ${tc.activePillBg} ${tc.activePillText} text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass} disabled:opacity-50`}
                  >
                    {profileLoading ? '...' : 'Save'}
                  </button>
                </div>
                {profileSuccess && (
                  <p className={`text-xs text-green-600 mt-2 ${tc.fontClass}`}>{profileSuccess}</p>
                )}
              </div>

              {/* Password Reset */}
              {isPasswordProvider && (
                <div>
                  <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Security</h3>
                  <button
                    onClick={handlePasswordReset}
                    disabled={loading}
                    className={`w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass} flex items-center justify-center gap-2`}
                  >
                    {loading ? (
                      <>
                        <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m2.25 4.5a6 6 0 01-7.5 0M7.5 8.25H3.75v10.5h16.5V8.25H16.5M12 15.75a3 3 0 01-3-3v-1.5a3 3 0 116 0v1.5a3 3 0 01-3 3z" />
                        </svg>
                        Reset Password
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Notifications */}
              <div>
                <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Notifications</h3>
                <div className={`flex items-center justify-between p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
                  <div className="flex-1 pr-3">
                    <p className={`${tc.fontClass} text-sm ${tc.text}`}>Chat notifications</p>
                    <p className={`text-xs mt-1 ${tc.muted} ${tc.fontClass}`}>{notifHint}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notifEnabled}
                    disabled={notifDisabled}
                    onClick={onToggleNotifications}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      notifEnabled ? 'bg-emerald-500' : 'bg-gray-400'
                    }`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${notifEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Sign Out */}
              <div className="pt-2">
                <button
                  onClick={onSignOut}
                  className={`w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass} flex items-center justify-center gap-2`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                  </svg>
                  Sign Out
                </button>
              </div>

              {/* Danger Zone */}
              <div className="pt-4 border-t border-red-200">
                <h3 className={`${tc.fontClass} text-red-500 font-medium text-sm mb-2`}>Danger Zone</h3>
                <p className={`text-xs ${tc.muted} ${tc.fontClass} mb-3`}>Permanently delete your account and all data.</p>
                <button
                  onClick={handleStartDeletion}
                  className="w-full py-2.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  Delete Account
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Layout Selection */}
              {onLayoutChange && (
                <div>
                  <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Layout</h3>
                  <div className="space-y-2">
                    <button
                      onClick={() => onLayoutChange('classic')}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors ${
                        layoutMode === 'classic'
                          ? `${tc.border} ${tc.activePillBg} ${tc.activePillText}`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      <span className={`${tc.fontClass} text-sm`}>Classic</span>
                      {layoutMode === 'classic' && (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => onLayoutChange('editorial')}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors ${
                        layoutMode === 'editorial'
                          ? `${tc.border} ${tc.activePillBg} ${tc.activePillText}`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      <span className={`${tc.fontClass} text-sm`}>Editorial</span>
                      {layoutMode === 'editorial' && (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.border} px-5 py-4`}>
          <button
            onClick={onClose}
            className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
