'use client';

import { useState } from 'react';
import { Workspace } from '@/types';

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  onSwitch: (workspaceId: string | null) => void;
  onCreate: () => void;
  onJoin: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspace,
  onSwitch,
  onCreate,
  onJoin,
  theme = 'light'
}: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
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
          <div className={`absolute top-full left-0 mt-1 w-64 border ${tc.borderColor} ${tc.dropdownBg} shadow-lg z-50 ${tc.roundedClass}`}>
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
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                onClick={() => {
                  onSwitch(workspace.id);
                  setIsOpen(false);
                }}
                className={`w-full px-4 py-3 text-left flex items-center gap-3 ${currentWorkspace?.id === workspace.id ? `${tc.activeBg} ${tc.activeText}` : tc.hoverBg} transition-colors`}
              >
                <svg className={`w-4 h-4 ${currentWorkspace?.id === workspace.id ? 'text-white' : tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <span className={`${tc.fontClass} ${currentWorkspace?.id === workspace.id ? 'text-white' : tc.textColor}`}>
                  {workspace.name}
                </span>
              </button>
            ))}

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