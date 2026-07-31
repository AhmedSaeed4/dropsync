'use client';

// LiveCallDropTile — the card a call drop renders as in the drops list (DropItem /
// EditorialDropItem's type==='call' branch), styled to match the editorial drop card (full border,
// rounded-lg, p-3, hover-border). Pulsing 🔴 LIVE badge, the host's avatar + name (resolved from
// workspaceMembers by callHostUid — NEVER a stored name), "N in call", and a Join button.
// onClick = hoverable ? onJoin : onMobileTap (mobile sees-but-can't-join). If THIS drop is the
// viewer's own active minimized call, the button reads "Reopen" instead.

import type { Drop } from '@/types';
import type { MemberInfo } from '@/lib/workspaces';
import { getCallTheme, type CallTheme, type CallVariant } from './callTheme';

interface LiveCallDropTileProps {
  drop: Drop;
  theme: CallTheme;
  variant: CallVariant;
  hoverable: boolean;
  members: MemberInfo[];
  /** True when this drop is the viewer's own active, minimized call (button → "Reopen"). */
  isReopen: boolean;
  onJoin: () => void;
  onMobileTap: () => void;
}

export function LiveCallDropTile({
  drop,
  theme,
  variant,
  hoverable,
  members,
  isReopen,
  onJoin,
  onMobileTap,
}: LiveCallDropTileProps) {
  const tc = getCallTheme(variant, theme);
  const hostName =
    members.find((m) => m.uid === drop.callHostUid)?.displayName ||
    drop.creatorName ||
    'Host';
  const initial = (hostName.charAt(0) || '?').toUpperCase();
  const inCall = (drop.callParticipantUids?.length ?? 0) || 1;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        (hoverable ? onJoin : onMobileTap)();
      }}
      className={`relative select-none flex items-center gap-3 p-3 cursor-pointer ${tc.cardBg} ${tc.border} border ${tc.rounded} transition-all group overflow-hidden ${tc.hoverBorder}`}
    >
      {/* Host avatar */}
      <div className={`w-10 h-10 shrink-0 flex items-center justify-center ${tc.rounded} border ${tc.border} ${tc.inactivePillBg} ${tc.text} ${tc.fontClass} text-sm font-medium`}>
        {initial}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* Pulsing LIVE badge */}
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 ${tc.rounded} bg-red-500/15 text-red-500 ${tc.fontClass} text-[10px]`}>
            <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
            LIVE
          </span>
          <span className={`${tc.text} ${tc.fontClass} text-sm font-medium tracking-tight truncate`}>{hostName}</span>
        </div>
        <p className={`${tc.muted} ${tc.fontClass} text-xs mt-1`}>
          {inCall} {inCall === 1 ? 'person' : 'people'} in call
          {drop.callStartedAt && (
            <span className="ml-2 opacity-70">
              · {formatAge(drop.callStartedAt)}
            </span>
          )}
        </p>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          (hoverable ? onJoin : onMobileTap)();
        }}
        className={`shrink-0 px-3 py-1.5 text-xs ${tc.rounded} ${tc.fontClass} transition-opacity hover:opacity-90 active:scale-[0.98] ${
          hoverable ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.inactivePillBg} ${tc.muted} cursor-not-allowed`
        }`}
      >
        {isReopen ? 'Reopen' : 'Join'}
      </button>
    </div>
  );
}

/** "Xm" age from the server-stamped call start. Pure (uses the passed date, not Date.now in render
 *  hot path — fine here since it's only re-evaluated on re-render). */
function formatAge(start: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - start.getTime()) / 60_000));
  if (mins < 1) return 'live';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
