'use client';

import { useState, useEffect } from 'react';
import { Workspace } from '@/types';
import { getWorkspaceMembers, type MemberInfo } from '@/lib/workspaces';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

/**
 * WorkspaceOptionsModal — the OWNER's choice modal (replaces the old inline delete-only
 * confirmation). Opened by the gear "Workspace options" button in the switchers.
 *
 * Two modes, decided by whether other members remain:
 *  - Solo owner: only the destructive Delete path is shown.
 *  - Has other members: a member picker + "Leave & transfer" (pick a successor who becomes
 *    owner; you leave; workspace + drops stay intact) + "Delete workspace" (destroys it for
 *    everyone).
 *
 * The member's "Leave workspace" flow is separate and untouched. Styling mirrors the existing
 * inline modal theme classes (dark / minimal / default-light) from ClassicLayout so it matches
 * across both layout families.
 */
interface Props {
  workspace: Workspace;
  theme: string; // 'dark' | 'minimal' | default('light')
  isDeleting: boolean;
  isLeaving: boolean;
  isKicking: boolean;
  onKick: (memberUid: string) => void;
  currentUserId: string | null;
  onDelete: () => void;
  onLeaveAndTransfer: (newOwnerId: string) => void;
  onClose: () => void;
  variant: 'classic' | 'editorial';
}

export default function WorkspaceOptionsModal({
  workspace,
  theme,
  isDeleting,
  isLeaving,
  isKicking,
  onKick,
  currentUserId,
  onDelete,
  onLeaveAndTransfer,
  onClose,
  variant,
}: Props) {
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | 'delete' | 'transfer' | 'kick'>(null);
  const [kickTargetId, setKickTargetId] = useState<string | null>(null);
  // Back closes only when not mid delete/transfer/kick (matches the disabled X/backdrop).
  useModalBackClose(true, () => { if (!(isDeleting || isLeaving || isKicking)) onClose(); });
  // Freeze the page (body overflow + Lenis) while this full-screen blocking modal is open, like
  // every other modal. Previously this overlay locked NEITHER, so the background scrolled/glided.
  useBodyScrollLock();

  // Fetch members on mount / when the workspace changes. `cancelled` prevents setState after
  // unmount; the modal is dismissed once a transfer/delete resolves, so this guards the race.
  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setSelectedMemberId(null);
    setConfirming(null);
    setKickTargetId(null);
    getWorkspaceMembers(workspace.members, workspace.ownerId)
      .then((fetched) => {
        if (cancelled) return;
        setMembers(fetched);
        const others = fetched.filter((m) => !m.isOwner);
        setSelectedMemberId(others.length > 0 ? others[0].uid : null);
      })
      .catch((error) => {
        console.error('Failed to load workspace members:', error);
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const busy = isDeleting || isLeaving || isKicking;
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const isEditorial = variant === 'editorial';
  // Editorial tokens (null in classic — classic keeps its inline theme classes).
  const tc = isEditorial ? getEditorialThemeColors(theme as 'light' | 'dark' | 'minimal') : null;

  // Label helper: editorial is always sentence-case; classic is sentence only in minimal,
  // else UPPERCASE mono.
  const L = (sentence: string, upper: string) => (isEditorial || isMinimal ? sentence : upper);

  // --- Variant-aware class strings. Classic is unchanged; editorial mirrors the inline
  // editorial Leave modal (w-96, rounded-lg, Raleway, plain border-b header, black buttons,
  // no red, sentence case). tc is only read when isEditorial (guarded below). ---
  const spinner = isEditorial
    ? 'w-4 h-4 border-2 border-current border-t-transparent animate-spin rounded-full'
    : `${'w-4 h-4'} border-2 border-current border-t-transparent animate-spin ${isMinimal ? 'rounded-full' : ''}`;
  const loadingSpinner = isEditorial && tc
    ? `w-5 h-5 border-2 ${tc.border} border-t-transparent animate-spin rounded-lg`
    : `w-5 h-5 border-2 ${isDark ? 'border-white/30 border-t-white' : 'border-[#1A1A1A]/30 border-t-[#1A1A1A]'} ${isMinimal ? 'rounded-full' : ''} animate-spin`;
  const btnFont = isMinimal ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]';
  const bodyText = isEditorial && tc ? `text-sm ${tc.fontClass} ${tc.muted}` : `text-sm ${isDark ? 'text-white/80' : 'text-[#1A1A1A]/80'}`;
  const helperText = isEditorial && tc ? `text-xs mt-1.5 ${tc.fontClass} ${tc.muted}` : `text-xs mt-1 ${isDark ? 'text-white/50' : 'text-[#1A1A1A]/50'}`;

  const panelClass = isEditorial && tc
    ? `relative z-10 w-96 border ${tc.border} ${tc.cardBg} rounded-lg overflow-hidden`
    : `relative z-10 w-80 border ${
        isDark ? 'bg-[#1A1A1A] border-white/10' : isMinimal ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'
      }`;
  const headerClass = isEditorial && tc
    ? `px-5 py-4 border-b ${tc.border} flex items-center justify-between`
    : `px-4 py-3 border-b ${
        isDark ? 'border-white/10' : isMinimal ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]'
      } flex items-center justify-between ${isMinimal ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`;
  const titleClass = isEditorial && tc ? `text-sm font-medium ${tc.fontClass} ${tc.text}` : `font-bold text-white ${btnFont}`;
  const closeBtnClass = isEditorial && tc
    ? `${tc.muted} hover:${tc.text} transition-colors disabled:opacity-50`
    : 'text-white/70 hover:text-white transition-colors disabled:opacity-50';

  // Editorial button chrome (no width — width/flex applied at the call site).
  const editorialPrimary = tc
    ? `px-4 py-2.5 text-sm ${tc.fontClass} bg-[#1a1a1a] hover:bg-[#333] text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50`
    : '';
  const editorialOutline = tc
    ? `px-4 py-2.5 text-sm ${tc.fontClass} border ${tc.border} rounded-lg ${tc.text} hover:bg-[#1a1a1a] hover:text-white transition-colors disabled:opacity-50`
    : '';

  // Classic button chrome (unchanged). Renamed from buttonChrome so the new `variant` prop
  // no longer collides with the old param name.
  const classicChrome = (kind: 'cancel' | 'danger' | 'primary') => {
    const bg =
      kind === 'cancel'
        ? isDark
          ? 'bg-white/10 hover:bg-white/20 text-white'
          : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]'
        : kind === 'danger'
        ? 'bg-red-500 hover:bg-red-600 text-white'
        : 'bg-[#FF5A47] hover:bg-[#FF5A47]/90 text-white';
    return `px-4 py-2 ${bg} transition-colors ${btnFont} flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${isMinimal ? 'rounded-lg' : ''}`;
  };

  // Members still loading.
  if (members === null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />
        <div className={`${panelClass} p-6 flex items-center justify-center`}>
          <div className={loadingSpinner} />
        </div>
      </div>
    );
  }

  const otherMembers = members.filter((m) => !m.isOwner);
  const selectedMember = otherMembers.find((m) => m.uid === selectedMemberId) || null;
  const kickTarget = members.find((m) => m.uid === kickTargetId) || null;
  const isSolo = otherMembers.length === 0;

  // Returns the chrome (no width) for a given action, branching on variant + mode. Roles:
  //  classic   — cancel=secondary, delete=red (always), transfer=#FF5A47 primary.
  //  editorial — cancel=outline, transfer=black primary, delete=primary in solo / outline in
  //              multi (destructive alternative de-emphasized; the warning text carries the danger).
  const actionBtnChrome = (action: 'cancel' | 'delete' | 'transfer') => {
    if (!isEditorial) {
      if (action === 'cancel') return classicChrome('cancel');
      if (action === 'delete') return classicChrome('danger');
      return classicChrome('primary');
    }
    if (action === 'cancel') return editorialOutline;
    if (action === 'transfer') return editorialPrimary;
    return isSolo ? editorialPrimary : editorialOutline;
  };

  // Confirm-view button is always the EMPHASIZED treatment (the confirm step is the primary
  // action, unlike the options view where delete is de-emphasized).
  const confirmBtnChrome = (action: 'delete' | 'transfer' | 'kick') => {
    if (!isEditorial) {
      // delete + kick → red danger; transfer → #FF5A47 primary.
      return action === 'transfer' ? classicChrome('primary') : classicChrome('danger');
    }
    return editorialPrimary; // editorial: black primary for all
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
      <div className="fixed inset-0 bg-black/50" onClick={() => !busy && onClose()} />
      <div className={panelClass}>
        {/* Header */}
        <div className={headerClass}>
          <h3 className={titleClass}>
            {confirming === 'delete'
              ? L('Delete workspace', 'DELETE_WORKSPACE')
              : confirming === 'transfer'
              ? L('Leave & transfer', 'LEAVE_&_TRANSFER')
              : confirming === 'kick'
              ? L('Remove member', 'REMOVE_MEMBER')
              : L('Workspace options', 'WORKSPACE_OPTIONS')}
          </h3>
          <button
            onClick={() => !busy && onClose()}
            className={closeBtnClass}
            disabled={busy}
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className={isEditorial ? 'p-5' : 'p-4'}>
          {confirming ? (
            <>
              <p className={`${bodyText} mb-4`}>
                {confirming === 'delete'
                  ? `Delete "${workspace.name}"? This permanently deletes the workspace and ALL its drops for everyone. This cannot be undone.`
                  : confirming === 'transfer'
                  ? `Leave "${workspace.name}" and make ${selectedMember?.displayName ?? 'the selected member'} the owner? You'll be removed from the workspace; the workspace and all its drops stay intact for remaining members.`
                  : `Remove ${kickTarget?.displayName ?? 'this member'} from "${workspace.name}"? They'll immediately lose access. The invite code will be rotated so they can't rejoin with the old code. Their existing drops and messages stay.`}
              </p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setConfirming(null)} disabled={busy} className={`flex-1 ${actionBtnChrome('cancel')}`}>
                  {L('Back', 'BACK')}
                </button>
                <button
                  onClick={
                    confirming === 'delete'
                      ? onDelete
                      : confirming === 'transfer'
                        ? () => selectedMemberId && onLeaveAndTransfer(selectedMemberId)
                        : () => kickTargetId && onKick(kickTargetId)
                  }
                  disabled={confirming === 'delete' ? isDeleting : confirming === 'transfer' ? isLeaving : isKicking}
                  className={`flex-1 ${confirmBtnChrome(confirming)}`}
                >
                  {confirming === 'delete'
                    ? (isDeleting ? (<><div className={spinner} />{L('Deleting...', 'DELETING...')}</>) : L('Confirm delete', 'CONFIRM_DELETE'))
                    : confirming === 'transfer'
                    ? (isLeaving ? (<><div className={spinner} />{L('Leaving...', 'LEAVING...')}</>) : L('Confirm transfer', 'CONFIRM_TRANSFER'))
                    : (isKicking ? (<><div className={spinner} />{L('Removing...', 'REMOVING...')}</>) : L('Confirm remove', 'CONFIRM_REMOVE'))}
                </button>
              </div>
            </>
          ) : isSolo ? (
            <>
              {/* Mode A: owner is the only member — destructive delete only. */}
              <p className={`${bodyText} mb-4`}>
                {`You're the only member of "${workspace.name}". Deleting will permanently remove the workspace and all its drops. This cannot be undone.`}
              </p>
              <div className="flex gap-2">
                <button onClick={() => !busy && onClose()} disabled={busy} className={`flex-1 ${actionBtnChrome('cancel')}`}>
                  {L('Cancel', 'CANCEL')}
                </button>
                <button onClick={() => setConfirming('delete')} disabled={isDeleting} className={`flex-1 ${actionBtnChrome('delete')}`}>
                  {isDeleting ? (
                    <>
                      <div className={spinner} />
                      {L('Deleting...', 'DELETING...')}
                    </>
                  ) : (
                    L('Delete', 'DELETE')
                  )}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Mode B: other members exist — choose a successor to transfer to, or delete. */}
              <p className={`${bodyText} mb-3`}>
                {`Choose what to do with "${workspace.name}".`}
              </p>

              {/* Member picker (transfer candidates). */}
              <div className={isEditorial && tc ? `mb-3 max-h-44 overflow-y-auto rounded-lg border ${tc.border}` : `mb-3 max-h-44 overflow-y-auto rounded ${isMinimal ? 'rounded-lg' : ''} ${isDark ? 'border border-white/10' : 'border border-[#1A1A1A]/10'}`}>
                {otherMembers.map((member) => {
                  const selected = member.uid === selectedMemberId;
                  return (
                    <div
                      key={member.uid}
                      role="button"
                      tabIndex={busy ? -1 : 0}
                      onClick={() => setSelectedMemberId(member.uid)}
                      onKeyDown={(e) => {
                        if (busy) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedMemberId(member.uid);
                        }
                      }}
                      className={isEditorial && tc
                        ? `w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${tc.fontClass} ${selected ? (isDark ? 'bg-white/10' : 'bg-[#1a1a1a]/10') : tc.inactivePillHoverBg}`
                        : `w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                            selected
                              ? isDark ? 'bg-white/15' : isMinimal ? 'bg-[#1A1A1A]/10' : 'bg-[#FF5A47]/10'
                              : isDark ? 'hover:bg-white/5' : 'hover:bg-[#1A1A1A]/5'
                          }`}
                    >
                      <div className={isEditorial && tc
                        ? `w-5 h-5 shrink-0 flex items-center justify-center rounded-full ${selected ? 'bg-[#1a1a1a] text-white' : `border ${tc.border} ${tc.text}`}`
                        : `w-5 h-5 shrink-0 flex items-center justify-center rounded-full ${
                            selected ? (isDark ? 'bg-white/25' : 'bg-[#FF5A47]') : (isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10')
                          }`}>
                        <span className={`text-[10px] font-medium ${isEditorial && tc ? (selected ? 'text-white' : tc.text) : 'text-white'}`}>{member.displayName.charAt(0).toUpperCase()}</span>
                      </div>
                      <span className={isEditorial && tc ? `flex-1 min-w-0 truncate text-sm ${tc.text}` : `flex-1 min-w-0 truncate text-sm ${isDark ? 'text-white/90' : 'text-[#1A1A1A]/90'}`}>
                        {member.displayName}
                      </span>
                      {member.uid !== currentUserId && (
                        // Defense-in-depth: owner is already filtered out of otherMembers, so this
                        // row is never the current user — but hide Remove for the current uid
                        // regardless. stopPropagation so picking Remove does NOT change the
                        // transfer radio selection. (Row is a div role=button so a real <button>
                        // can validly nest here — invalid nested-button HTML was the reason for
                        // converting the row off <button>.)
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setKickTargetId(member.uid);
                            setConfirming('kick');
                          }}
                          // Mirror the onClick stopPropagation on the KEYDOWN path too. Without this,
                          // Enter/Space on the focused button bubbles to the row <div role=button>
                          // whose onKeyDown calls e.preventDefault() — that cancels the button's
                          // synthesized activation click (kick unreachable by keyboard) AND runs
                          // setSelectedMemberId (silently re-points the transfer radio). Stopping
                          // propagation here lets the button activate normally; do NOT preventDefault.
                          onKeyDown={(e) => e.stopPropagation()}
                          disabled={busy}
                          className={isEditorial && tc
                            ? `shrink-0 px-2.5 py-1 text-xs ${tc.fontClass} border ${tc.border} rounded ${tc.muted} hover:bg-[#1a1a1a] hover:text-white transition-colors disabled:opacity-50`
                            : `shrink-0 px-2.5 py-1 ${btnFont} ${isDark ? 'text-red-300 hover:text-red-200' : isMinimal ? 'text-red-600 hover:text-red-700' : 'text-red-500 hover:text-red-600'} transition-colors disabled:opacity-50`}
                        >
                          {L('Remove', 'REMOVE')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Leave & transfer. */}
              <button
                onClick={() => selectedMemberId && setConfirming('transfer')}
                disabled={isLeaving || !selectedMemberId}
                className={`w-full ${actionBtnChrome('transfer')}`}
              >
                {isLeaving ? (
                  <>
                    <div className={spinner} />
                    {L('Leaving...', 'LEAVING...')}
                  </>
                ) : (
                  L('Leave & transfer', 'LEAVE_&_TRANSFER')
                )}
              </button>
              <p className={helperText}>
                {selectedMember
                  ? `You'll leave and ${selectedMember.displayName} will become the owner. The workspace and all its drops stay intact for remaining members.`
                  : 'Select a member to transfer ownership to.'}
              </p>

              {/* Delete workspace. */}
              <button onClick={() => setConfirming('delete')} disabled={isDeleting} className={`w-full mt-3 ${actionBtnChrome('delete')}`}>
                {isDeleting ? (
                  <>
                    <div className={spinner} />
                    {L('Deleting...', 'DELETING...')}
                  </>
                ) : (
                  L('Delete workspace', 'DELETE_WORKSPACE')
                )}
              </button>
              <p className={helperText}>Permanently deletes the workspace and ALL its drops for everyone. Cannot be undone.</p>

              <div className="flex gap-2 mt-3">
                <button onClick={() => !busy && onClose()} disabled={busy} className={`flex-1 ${actionBtnChrome('cancel')}`}>
                  {L('Cancel', 'CANCEL')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
