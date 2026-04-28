'use client';

import { useState, useEffect } from 'react';
import { Workspace } from '@/types';
import { getWorkspaceMembers, MemberInfo } from '@/lib/workspaces';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialWorkspaceSwitcherProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentUserId: string | null;
  onSwitch: (workspaceId: string | null) => void;
  onCreate: () => void;
  onJoin: () => void;
  onDelete: (workspace: Workspace) => void;
  onLeave: (workspace: Workspace) => void;
  theme?: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
}

export function EditorialWorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  currentUserId,
  onSwitch,
  onCreate,
  onJoin,
  onDelete,
  onLeave,
  theme = 'light',
  showChat = false,
}: EditorialWorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(null);
  const [membersMap, setMembersMap] = useState<Record<string, MemberInfo[]>>({});

  const tc = getEditorialThemeColors(theme);

  // Fetch member details when dropdown opens
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
      {/* Main button - editorial pill style */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center border ${tc.border} ${tc.bg} rounded-md hover:border-[#1a1a1a] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
          showChat ? 'gap-1.5 px-3 py-1.5' : 'gap-2 px-4 py-2'
        }`}
      >
        {/* People icon */}
        <svg
          className={`${tc.text} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'w-3.5 h-3.5' : 'w-4 h-4'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>

        {/* Workspace name */}
        <span
          className={`${tc.fontClass} ${tc.text} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
            showChat ? 'text-sm' : 'text-[15px]'
          }`}
        >
          {currentWorkspace?.name || 'Personal'}
        </span>

        {/* Chevron */}
        <svg
          className={`${tc.muted} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''} ${
            showChat ? 'w-3.5 h-3.5' : 'w-4 h-4'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            className={`absolute top-full left-0 mt-1 w-52 border ${tc.border} ${tc.bg} rounded-lg shadow-lg z-50 overflow-hidden`}
          >
            {/* Personal option */}
            <button
              onClick={() => {
                onSwitch(null);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
                !currentWorkspace ? `${tc.activePillBg} ${tc.activePillText}` : `hover:bg-[#1a1a1a]/5`
              }`}
            >
              <svg
                className={`w-3.5 h-3.5 ${!currentWorkspace ? 'text-white' : tc.text}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              <span className={`${tc.fontClass} text-sm ${!currentWorkspace ? 'text-white' : tc.text}`}>
                Personal
              </span>
            </button>

            {/* Divider */}
            {workspaces.length > 0 && <div className={`border-t ${tc.border}`} />}

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
                    className={`w-full px-3 py-2 flex items-center justify-between cursor-pointer transition-colors ${
                      isActive ? (theme === 'dark' ? 'bg-white/10' : tc.activePillBg + ' ' + tc.activePillText) : 'hover:bg-[#1a1a1a]/5'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <svg
                        className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-white' : tc.text}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                        />
                      </svg>
                      <span
                        className={`${tc.fontClass} text-sm ${isActive ? 'text-white' : tc.text} truncate`}
                      >
                        {workspace.name}
                      </span>
                    </div>

                    <div className="flex items-center gap-0.5 z-10">
                      {/* Members toggle */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedWorkspaceId(isExpanded ? null : workspace.id);
                        }}
                        className={`p-1 rounded transition-colors ${
                          isActive ? 'hover:bg-white/20' : 'hover:bg-[#1a1a1a]/5'
                        }`}
                        title="Show members"
                      >
                        <svg
                          className={`w-3 h-3 ${isActive ? 'text-white/70' : tc.muted}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
                          />
                        </svg>
                      </button>

                      {/* Copy invite */}
                      {isOwner && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyInviteCode(workspace.inviteCode, workspace.id);
                          }}
                          className={`p-1 rounded transition-colors ${
                            isActive ? 'hover:bg-white/20' : 'hover:bg-[#1a1a1a]/5'
                          }`}
                          title="Copy invite code"
                        >
                          {copiedId === workspace.id ? (
                            <svg
                              className="w-3 h-3 text-green-500"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          ) : (
                            <svg
                              className={`w-3 h-3 ${isActive ? 'text-white/70' : tc.muted}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              strokeWidth={1.5}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                              />
                            </svg>
                          )}
                        </button>
                      )}

                      {/* Delete/Leave */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isOwner) {
                            onDelete(workspace);
                          } else {
                            onLeave(workspace);
                          }
                        }}
                        className={`p-1 rounded transition-colors ${
                          isActive ? 'hover:bg-white/20' : 'hover:bg-[#1a1a1a]/5'
                        }`}
                        title={isOwner ? 'Delete workspace' : 'Leave workspace'}
                      >
                        <svg
                          className={`w-3 h-3 ${isActive ? 'text-white/70' : tc.muted}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                        >
                          {isOwner ? (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          ) : (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                            />
                          )}
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded member list */}
                  {isExpanded && (
                    <div
                      className={`px-3 py-2 border-t ${tc.border} ${
                        isActive ? (theme === 'dark' ? 'bg-white/5' : 'bg-[#1a1a1a]/5') : (theme === 'dark' ? 'bg-white/5' : 'bg-[#f5f5f5]')
                      }`}
                    >
                      {!members ? (
                        <div className="flex justify-center py-1.5">
                          <div
                            className={`w-3.5 h-3.5 border ${tc.border} border-t-current animate-spin rounded-full`}
                          />
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          {members.map((member) => (
                            <div
                              key={member.uid}
                              className={`flex items-center gap-1.5 py-0.5 text-xs ${
                                isActive ? (theme === 'dark' ? 'text-white/60' : 'text-[#1a1a1a]/70') : tc.muted
                              }`}
                            >
                              <div
                                className={`w-3.5 h-3.5 shrink-0 rounded-full ${
                                  isActive
                                    ? theme === 'dark' ? 'bg-white/10' : 'bg-[#1a1a1a]/10'
                                    : theme === 'dark' ? 'bg-white/10' : 'bg-[#1a1a1a]/5'
                                } flex items-center justify-center`}
                              >
                                <span className="text-[7px] font-medium">
                                  {member.displayName.charAt(0).toUpperCase()}
                                </span>
                              </div>
                              <span className="truncate">{member.displayName}</span>
                              {member.isOwner && (
                                <span className="shrink-0 text-[8px] opacity-50">
                                  (owner)
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
            <div className={`border-t ${tc.border}`} />

            {/* Create */}
            <button
              onClick={() => {
                onCreate();
                setIsOpen(false);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 ${tc.text}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span className={`${tc.fontClass} text-sm ${tc.text}`}>Create workspace</span>
            </button>

            {/* Join */}
            <button
              onClick={() => {
                onJoin();
                setIsOpen(false);
              }}
              className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[#1a1a1a]/5 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 ${tc.text}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                />
              </svg>
              <span className={`${tc.fontClass} ${tc.text}`}>Join workspace</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
