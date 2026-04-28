'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialJoinWorkspaceModalProps {
  onJoin: (code: string) => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function EditorialJoinWorkspaceModal({ onJoin, onClose, theme = 'light' }: EditorialJoinWorkspaceModalProps) {
  useBodyScrollLock();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tc = getEditorialThemeColors(theme);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await onJoin(code.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join workspace');
    }

    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl`}>
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Join Workspace</h2>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className={`bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 ${tc.fontClass}`}>
              {error}
            </div>
          )}

          <div>
            <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1.5`}>Invite Code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              required
              className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass} uppercase`}
            />
            <p className={`text-xs ${tc.muted} ${tc.fontClass} mt-1.5`}>
              Ask the workspace owner for an invite code
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className={`flex-1 border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity ${tc.fontClass} flex items-center justify-center gap-2`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  Joining...
                </>
              ) : (
                'Join'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
