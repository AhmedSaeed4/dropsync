'use client';

import type { Workspace } from '@/types';

export function ImportingWorkspaceRow({ workspace, theme, onSwitch }: {
  workspace: Workspace;
  theme: 'light' | 'dark' | 'minimal';
  onSwitch: (workspaceId: string) => void;
}) {
  return <button type="button" onClick={() => onSwitch(workspace.id)}
    aria-label={`Open ${workspace.name}, importing`}
    className={`w-full min-h-11 px-4 py-3 text-left flex items-center justify-between gap-3 ${theme === 'dark' ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-black/5'}`}>
    <span className="truncate">{workspace.name}</span>
    <span className={`shrink-0 text-[11px] font-medium ${theme === 'dark' ? 'text-white/80' : 'text-[#1A1A1A]/75'}`}>Importing…</span>
  </button>;
}
