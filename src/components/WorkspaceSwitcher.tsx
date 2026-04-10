'use client';

import { useState, useEffect } from 'react';
import { Workspace } from '@/types';
import { getWorkspaceMembers, MemberInfo } from '@/lib/workspaces';

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentUserId: string | null;
  onSwitch: (workspaceId: string | null) => void;
  onCreate: () => void;
  onJoin: () => void;
  onDelete: (workspace: Workspace) => void;
  onLeave: (workspace: Workspace) => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  currentUserId,
  onSwitch,
  onCreate,
  onJoin,
  onDelete,
  onLeave,
  theme = 'light'
}: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(null);
  const [membersMap, setMembersMap] = useState<Record<string, MemberInfo[]>>({});
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const getThemeColors = () => {
    if (isMinimal) {
      return {
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/60',
        borderColor: 'border-[#1A1A1A]/20',
        hoverBg: 'hover:bg-[#C5C9B8]',
        activeBg: 'bg-[#1A1A1A]',
        activeText: 'text-white',
        dropdownBg: 'bg-[#D4D8C8]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
      };
    }
    return {
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      hoverBg: isDark ? 'hover:bg-[#2A2A2A]' : 'hover:bg-[#F5F2ED]',
      activeBg: 'bg-[#FF5A47]',
      activeText: 'text-white',
      dropdownBg: isDark ? 'bg-[#1A1A1A]' : 'bg-white',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
    };
  };

  const tc = getThemeColors();

  // Fetch member details when dropdown opens or workspaces change
  useEffect(() => {
    if (!isOpen || workspaces.length === 0) return;

    let cancelled = false;

    const fetchMembers = async () => {
      const newMembers: Record<string, MemberInfo[]> = {};

      await Promise.all(
        workspaces.map(async (ws) => {
          const members = await getWorkspaceMembers(ws.members, ws.ownerId);
          if (!cancelled) {
            newMembers[ws.id] = members;
          }
        })
      );

      if (!cancelled) {
        setMembersMap(newMembers);
      }
    };

    fetchMembers();

    return () => { cancelled = true; };
  }, [isOpen, workspaces]);

  const copyInviteCode = async (code: string, workspaceId: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(workspaceId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = code;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedId(workspaceId);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 border ${tc.borderColor} ${tc.bgColor} ${tc.hoverBg} transition-colors ${tc.roundedClass}`}
      >
        <svg className={`w-4 h-4 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span className={`${tc.fontClass} ${tc.textColor}`}>
          {currentWorkspace ? currentWorkspace.name : (isMinimal ? 'Personal' : 'PERSONAL')}
        </span>
        <svg className={`w-4 h-4 ${tc.textMuted} transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className={`absolute top-full ${isMinimal ? 'right-0 sm:left-0 sm:right-auto' : 'left-0'} mt-1 w-56 sm:w-64 border ${tc.borderColor} ${tc.dropdownBg} shadow-lg z-50 ${tc.roundedClass}`}>
            {/* Personal option */}
            <button
              onClick={() => {
                onSwitch(null);
                setIsOpen(false);
              }}
              className={`w-full px-4 py-3 text-left flex items-center gap-3 ${!currentWorkspace ? `${tc.activeBg} ${tc.activeText}` : tc.hoverBg} transition-colors ${tc.roundedClass} ${isOpen && !currentWorkspace ? '' : ''}`}
              style={{ borderRadius: isMinimal && !currentWorkspace ? '0.5rem 0.5rem 0 0' : undefined }}
            >
              <svg className={`w-4 h-4 ${!currentWorkspace ? 'text-white' : tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className={`${tc.fontClass} ${!currentWorkspace ? 'text-white' : tc.textColor}`}>
                {isMinimal ? 'Personal' : 'PERSONAL'}
              </span>
            </button>

            {/* Divider */}
            {workspaces.length > 0 && (
              <div className={`border-t ${tc.borderColor}`} />
            )}

            {/* Workspaces */}
            {workspaces.map((workspace) => {
              const isOwner = currentUserId === workspace.ownerId;
              const isActive = currentWorkspace?.id === workspace.id;
              const isExpanded = expandedWorkspaceId === workspace.id;
              const members = membersMap[workspace.id];

              return (
                <div key={workspace.id}>
                  <div
                    onClick={() => {
                      onSwitch(workspace.id);
                      setIsOpen(false);
                    }}
                    className={`w-full px-4 py-3 flex items-center justify-between cursor-pointer ${isActive ? `${tc.activeBg}` : tc.hoverBg} transition-colors`}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <svg className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      <span className={`${tc.fontClass} ${isActive ? 'text-white' : tc.textColor} truncate`}>
                        {workspace.name}
                      </span>
                      {/* Member count badge */}
                      <span className={`shrink-0 ${isMinimal ? 'text-[10px]' : 'text-[9px]'} ${isActive ? (isMinimal ? 'text-white/60' : 'text-white/70') : tc.textMuted}`}>
                        {workspace.members.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 z-10">
                      {/* Members toggle */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedWorkspaceId(isExpanded ? null : workspace.id);
                        }}
                        className={`p-1.5 ${isActive ? 'hover:bg-white/20' : tc.hoverBg} ${tc.roundedClass} transition-colors`}
                        title="Show members"
                      >
                        <svg className={`w-3.5 h-3.5 ${isActive ? 'text-white/70' : tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                        </svg>
                      </button>
                      {isOwner && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyInviteCode(workspace.inviteCode, workspace.id);
                          }}
                          className={`p-1.5 ${isActive ? 'hover:bg-white/20' : tc.hoverBg} ${tc.roundedClass} transition-colors relative`}
                          title="Copy invite code"
                        >
                          {copiedId === workspace.id ? (
                            <svg className={`w-3.5 h-3.5 ${isMinimal ? 'text-[#1A1A1A]' : 'text-green-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg className={`w-3.5 h-3.5 ${isActive ? 'text-white/70' : tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                            </svg>
                          )}
                        </button>
                      )}
                      {/* Delete/Leave button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isOwner) {
                            onDelete(workspace);
                          } else {
                            onLeave(workspace);
                          }
                        }}
                        className={`p-1.5 ${isActive ? 'hover:bg-white/20' : tc.hoverBg} ${tc.roundedClass} transition-colors`}
                        title={isOwner ? 'Delete workspace' : 'Leave workspace'}
                      >
                        <svg className={`w-3.5 h-3.5 ${isActive ? 'text-white/70' : tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {isOwner ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                          )}
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded member list */}
                  {isExpanded && (
                    <div className={`px-4 py-2 ${isActive ? (isMinimal ? 'bg-[#1A1A1A]/10' : 'bg-[#FF5A47]/10') : (isMinimal ? 'bg-[#C5C9B8]/50' : isDark ? 'bg-white/5' : 'bg-[#F5F2ED]')} border-t ${tc.borderColor}`}>
                      {!members ? (
                        <div className="flex justify-center py-2">
                          <div className={`w-4 h-4 border ${isMinimal ? 'border-[#1A1A1A]/30 border-t-[#1A1A1A]' : isDark ? 'border-white/30 border-t-white' : 'border-[#1A1A1A]/30 border-t-[#1A1A1A]'} animate-spin rounded-full`} />
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {members.map((member) => (
                            <div key={member.uid} className={`flex items-center gap-2 py-1 ${isMinimal ? 'text-[11px]' : 'text-[9px]'} ${isActive ? (isMinimal ? 'text-[#1A1A1A]/70' : 'text-white/70') : tc.textMuted}`}>
                              <div className={`w-4 h-4 shrink-0 ${isActive ? (isMinimal ? 'bg-[#1A1A1A]/20' : 'bg-white/20') : (isMinimal ? 'bg-[#1A1A1A]/10' : isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10')} flex items-center justify-center ${isMinimal ? 'rounded-full' : ''}`}>
                                <span className="text-[8px] font-medium">{member.displayName.charAt(0).toUpperCase()}</span>
                              </div>
                              <span className="truncate">{member.displayName}</span>
                              {member.isOwner && (
                                <span className={`shrink-0 ${isMinimal ? 'text-[9px]' : 'text-[8px]'} ${isActive ? (isMinimal ? 'text-[#1A1A1A]/40' : 'text-white/50') : tc.textMuted}`}>
                                  {isMinimal ? '(owner)' : 'OWNER'}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Divider */}
            <div className={`border-t ${tc.borderColor}`} />

            {/* Actions */}
            <button
              onClick={() => {
                onCreate();
                setIsOpen(false);
              }}
              className={`w-full px-4 py-3 text-left flex items-center gap-3 ${tc.hoverBg} transition-colors`}
            >
              <svg className={`w-4 h-4 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              <span className={`${tc.fontClass} ${tc.textColor}`}>
                {isMinimal ? 'Create workspace' : 'CREATE_WORKSPACE'}
              </span>
            </button>
            <button
              onClick={() => {
                onJoin();
                setIsOpen(false);
              }}
              className={`w-full px-4 py-3 text-left flex items-center gap-3 ${tc.hoverBg} transition-colors`}
              style={{ borderRadius: isMinimal ? '0 0 0.5rem 0.5rem' : undefined }}
            >
              <svg className={`w-4 h-4 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              <span className={`${tc.fontClass} ${tc.textColor}`}>
                {isMinimal ? 'Join workspace' : 'JOIN_WORKSPACE'}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
