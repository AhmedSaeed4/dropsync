'use client';

// LiveCallModal — the core call UI. ONE shared component (`variant` + `theme`) cloned from the
// PreviewModal shell. Opens straight into the in-app full-screen view (card fills the app area).
// useBodyScrollLock() + useModalBackClose(status==='joined', onMinimize) so the BROWSER BACK button
// minimizes to the floating pill (never mid-join, never an accidental leave); backdrop click also
// minimizes. The corner button toggles the real browser Fullscreen API on the modal card (whole
// screen, chrome hidden); Esc in browser-fullscreen exits to the in-app view via the browser's native
// Esc-exit, with the fullscreenchange listener keeping React state in sync. An unmount effect exits
// fullscreen so minimize/leave/route-change never strand the browser. Operating on a real DOM element
// sidesteps the #app-shell transform landmine. A Zoom-style footer toolbar wires Mute / Camera /
// Share-screen / Minimize (desktop) / Leave (red).

import { useEffect, useRef, useState } from 'react';
import type { Drop } from '@/types';
import type { MemberInfo } from '@/lib/workspaces';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import type { CallStatus } from '@/hooks/useLiveKitCall';
import { getCallTheme, type CallTheme, type CallVariant } from './callTheme';

const E2EE_TITLE = 'Call media is end-to-end encrypted; call metadata is handled like your other data.';
const CALL_MAX = 4;

interface LiveCallModalProps {
  drop: Drop;
  variant: CallVariant;
  theme: CallTheme;
  hoverable: boolean;
  status: CallStatus;
  participantUids: string[];
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  remoteScreenStreams: Record<string, MediaStream>;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** Whether the local participant has a camera at all (audio-only join → false → Camera btn disabled). */
  cameraAvailable: boolean;
  screenSharing: boolean;
  members: MemberInfo[];
  currentUserId?: string;
  onMinimize: () => void;
  onLeave: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
}

export function LiveCallModal(props: LiveCallModalProps) {
  const {
    drop, variant, theme, hoverable, status,
    participantUids, localStream, localScreenStream, remoteStreams, remoteScreenStreams,
    micEnabled, cameraEnabled, cameraAvailable, screenSharing, members, currentUserId,
    onMinimize, onLeave, onToggleMic, onToggleCamera, onToggleScreenShare,
  } = props;

  useBodyScrollLock();
  // Browser-back / mobile-back MINIMIZES to the floating pill (never mid-join, never an accidental
  // leave). Esc is intentionally NOT wired through here: in TRUE browser fullscreen the browser
  // exits fullscreen on Esc natively and the fullscreenchange listener below returns us to the
  // in-app view; in the in-app view Esc does nothing (use Leave / Minimize / back to close). The
  // backdrop click also minimizes. (useModalBackClose is popstate-only — see lib/modalBackClose.ts.)
  useModalBackClose(status === 'joined', onMinimize);

  const containerRef = useRef<HTMLDivElement>(null);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  // Drive fullscreen state from the browser's fullscreenchange event (not a manual toggle) so the
  // native Esc-exit and any other exit path keep React state in sync. The corner button calls the
  // real Fullscreen API on the modal card → the call fills the whole screen with browser chrome
  // hidden. Operating on a real DOM element sidesteps the #app-shell transform landmine.
  useEffect(() => {
    const onFsChange = () => setIsBrowserFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  // Exit fullscreen on unmount so minimize / leave / route-change never strand the browser in
  // fullscreen — covers every teardown path uniformly (not just the Leave button).
  useEffect(() => () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (containerRef.current) containerRef.current.requestFullscreen().catch(() => {});
  };

  const [spotlightKey, setSpotlightKey] = useState<string | null>(null);
  const tc = getCallTheme(variant, theme);

  const hostName = members.find((m) => m.uid === drop.callHostUid)?.displayName || drop.creatorName || 'Host';
  const inCall = participantUids.length + 1; // others + me

  // Build the tile list: local first ("You"), then remotes. Screen-share tiles render above the grid.
  const tiles: { key: string; stream: MediaStream | null; name: string; mirrored: boolean; muted: boolean; cameraOn: boolean; micOn: boolean }[] = [
    {
      key: 'me',
      stream: localStream,
      name: 'You',
      mirrored: true,
      muted: true,
      cameraOn: cameraEnabled,
      micOn: micEnabled,
    },
    ...participantUids.map((uid) => ({
      key: uid,
      stream: remoteStreams[uid] ?? null,
      name: members.find((m) => m.uid === uid)?.displayName || 'Participant',
      mirrored: false,
      muted: false,
      cameraOn: !!(remoteStreams[uid]?.getVideoTracks().some((t) => t.enabled)),
      micOn: !!(remoteStreams[uid]?.getAudioTracks().some((t) => t.enabled)),
    })),
  ];

  const screenTiles: { key: string; stream: MediaStream | null; name: string; muted: boolean }[] = [];
  if (localScreenStream) screenTiles.push({ key: 'me-screen', stream: localScreenStream, name: 'Your screen', muted: true });
  for (const [uid, s] of Object.entries(remoteScreenStreams)) {
    screenTiles.push({ key: `${uid}-screen`, stream: s, name: `${members.find((m) => m.uid === uid)?.displayName || 'Participant'}'s screen`, muted: false });
  }

  // Spotlight selector: auto-select the first remote screen (or local if none), and re-select if
  // the current spotlight disappears (peer stopped sharing). Lets each member click a screen
  // thumbnail to promote it to the main stage when multiple peers share simultaneously.
  const screenTileKeys = screenTiles.map((t) => t.key).join(',');
  useEffect(() => {
    if (screenTiles.length === 0) return;
    if (screenTiles.some((t) => t.key === spotlightKey)) return;
    const firstRemote = screenTiles.find((t) => t.key !== 'me-screen');
    setSpotlightKey(firstRemote?.key ?? screenTiles[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenTileKeys]);

  // Grid by participant count: 1=full, 2=side-by-side, 3–4=2×2. Explicit row counts (+ flex-1 on the
  // grid) make every cell FILL the fixed media region, so the panel height is identical for 1/2/3/4
  // participants — joining or leaving only reshuffles tiles, never grows/shrinks the panel.
  const gridCols = inCall <= 1 ? 'grid-cols-1' : 'grid-cols-2';
  const gridRows = inCall <= 2 ? 'grid-rows-1' : 'grid-rows-2';

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-[999] p-4 transition-colors duration-300`}
      onClick={(e) => e.target === e.currentTarget && onMinimize()}
    >
      <div
        ref={containerRef}
        className={`${tc.cardBg} ${tc.border} border ${isBrowserFullscreen ? '' : tc.rounded} ${isBrowserFullscreen ? 'w-full h-full' : 'w-full h-full max-w-[1200px]'} flex flex-col overflow-hidden shadow-2xl`}
      >
        {/* Header */}
        <div className={`border-b ${tc.border} px-4 py-3 flex items-center justify-between gap-3 shrink-0`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 ${tc.rounded} bg-red-500/15 text-red-500 ${tc.fontClass} text-[10px] shrink-0`}>
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
              LIVE
            </span>
            <span className={`${tc.text} ${tc.fontClass} text-sm font-medium tracking-tight truncate`}>{hostName}</span>
            <span className={`${tc.muted} ${tc.fontClass} text-xs shrink-0`}>{inCall} in call</span>
            <svg className={`w-4 h-4 ${tc.muted} shrink-0`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <title>{E2EE_TITLE}</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Full-screen button — toggles the real browser Fullscreen API on the modal card */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className={`w-8 h-8 flex items-center justify-center ${tc.inactivePillBg} ${tc.text} ${tc.rounded} hover:opacity-80 transition-opacity`}
              title={isBrowserFullscreen ? 'Exit full screen' : 'Enter full screen'}
            >
              {isBrowserFullscreen ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              )}
            </button>
            <button type="button" onClick={onMinimize} className={`w-8 h-8 flex items-center justify-center ${tc.text} hover:opacity-70 transition-opacity`} title="Minimize">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
              </svg>
            </button>
            <button type="button" onClick={onMinimize} className={`w-8 h-8 flex items-center justify-center ${tc.text} hover:opacity-70 transition-opacity`} title="Close">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body — fixed-height media region (the modal card fills the viewport; this flex-1 region is
            therefore a CONSTANT height regardless of camera/screen-share/participant count).
            overflow-hidden so a tile reshuffle can never spawn a scrollbar that shifts the layout. */}
        <div className={`flex-1 min-h-0 overflow-hidden bg-black/60 p-3 flex flex-col gap-3`}>
          {status !== 'joined' && status !== 'leaving' && (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="w-6 h-6 border border-white/30 border-t-white animate-spin rounded-full" />
                <p className={`${tc.fontClass} text-sm text-white/70`}>Connecting…</p>
              </div>
            </div>
          )}

          {(status === 'joined' || status === 'leaving') && (
            <>
              {screenTiles.length > 0 ? (
                // Screen-share: the spotlight screen fills the main area; non-spotlighted screens
                // show as clickable thumbnails above the camera tiles. Each member independently
                // picks which screen to view big (spotlightKey). Both live WITHIN the fixed-height
                // region, so toggling screen-share only RESHUFFLES tiles — never grows/shrinks.
                <div className="flex flex-1 min-h-0 gap-2">
                  <div className="flex-1 min-h-0 flex flex-col gap-1">
                    {screenTiles.filter((t) => t.key === spotlightKey).map((t) => (
                      <VideoTile key={t.key} stream={t.stream} name={t.name} muted={t.muted} mirrored={false} cameraOn micOn fontClass={tc.fontClass} className="flex-1 min-h-0 w-full" prominent />
                    ))}
                  </div>
                  <div className="w-24 sm:w-32 shrink-0 flex flex-col gap-2 overflow-y-auto">
                    {screenTiles.filter((t) => t.key !== spotlightKey).map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setSpotlightKey(t.key)}
                        className="flex-1 min-h-0 relative group rounded-lg overflow-hidden"
                        title={`Spotlight ${t.name}`}
                      >
                        <VideoTile stream={t.stream} name={t.name} muted={t.muted} mirrored={false} cameraOn micOn fontClass={tc.fontClass} className="h-full w-full" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                          <svg className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                          </svg>
                        </div>
                      </button>
                    ))}
                    {tiles.map((t) => (
                      <VideoTile key={t.key} stream={t.stream} name={t.name} muted={t.muted} mirrored={t.mirrored} cameraOn={t.cameraOn} micOn={t.micOn} fontClass={tc.fontClass} className="flex-1 min-h-0 w-full" />
                    ))}
                  </div>
                </div>
              ) : (
                // Participant grid fills the fixed media region (cells stretch via grid-rows-*).
                <div className={`grid ${gridCols} ${gridRows} gap-2 flex-1 min-h-0`}>
                  {tiles.map((t) => (
                    <VideoTile
                      key={t.key}
                      stream={t.stream}
                      name={t.name}
                      muted={t.muted}
                      mirrored={t.mirrored}
                      cameraOn={t.cameraOn}
                      micOn={t.micOn}
                      fontClass={tc.fontClass}
                      className="h-full w-full min-h-0"
                    />
                  ))}
                </div>
              )}
              <div className={`text-center ${tc.fontClass} ${tc.muted} text-xs shrink-0`}>
                {inCall}/{CALL_MAX} participants — {hoverable ? 'desktop call' : 'desktop-only'}
              </div>
            </>
          )}
        </div>

        {/* Footer — Zoom-style toolbar */}
        <div className={`border-t ${tc.border} px-4 py-3 flex items-center justify-center gap-2 shrink-0`}>
          <ToolbarButton label={micEnabled ? 'Mute' : 'Unmute'} active={!micEnabled} tc={tc} onClick={onToggleMic}>
            {micEnabled ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            )}
          </ToolbarButton>
          <ToolbarButton label={cameraEnabled ? 'Stop video' : 'Start video'} active={!cameraEnabled} tc={tc} onClick={onToggleCamera} disabled={!cameraAvailable}>
            {cameraEnabled ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88" />
              </svg>
            )}
          </ToolbarButton>
          <ToolbarButton label={screenSharing ? 'Stop share' : 'Share screen'} active={screenSharing} tc={tc} onClick={onToggleScreenShare}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
            </svg>
          </ToolbarButton>
          {hoverable && (
            <ToolbarButton label="Minimize" tc={tc} onClick={onMinimize}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
              </svg>
            </ToolbarButton>
          )}
          <button
            type="button"
            onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
              onLeave();
            }}
            className={`flex items-center gap-2 px-4 py-2 ${tc.rounded} ${tc.fontClass} text-sm bg-red-500 text-white hover:bg-red-600 transition-colors`}
            title="Leave call"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

/** One video tile with a mic-off overlay + name. Binds srcObject via an effect (no URL to revoke). */
function VideoTile({
  stream, name, muted, mirrored, cameraOn, micOn, className, prominent, fontClass,
}: {
  stream: MediaStream | null;
  name: string;
  muted: boolean;
  mirrored: boolean;
  cameraOn: boolean;
  micOn: boolean;
  className?: string;
  prominent?: boolean;
  fontClass?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  // Whether the stream has any LIVE, ENABLED video track to actually draw. When FALSE (audio-only
  // remote, or camera turned off), we hide the <video> visually but KEEP IT IN THE DOM so its audio
  // tracks still play. The OLD condition (`stream && cameraOn !== false`) skipped <video> entirely
  // for audio-only peers — the received mic track had no media element to play through, so the call
  // was SILENT for audio-only peers (but screen-share audio worked because the screen tile always
  // has video → <video> rendered → audio plays). Keeping <video> always mounted (when stream
  // exists) and just visually hiding it when there's no video fixes the dead-mic bug.
  const hasVideo = !!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  return (
    <div className={`relative overflow-hidden rounded-lg bg-black flex items-center justify-center ${className || ''}`}>
      {stream ? (
        <>
          <video
            ref={ref}
            autoPlay
            muted={muted}
            playsInline
            className={`h-full w-full ${prominent ? 'object-contain' : 'object-cover'} ${mirrored ? '-scale-x-100' : ''} ${hasVideo ? '' : 'opacity-0 absolute inset-0'}`}
          />
          {!hasVideo && (
            <div className="flex items-center justify-center w-full h-full">
              <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white text-base font-medium">
                {(name || '?').charAt(0).toUpperCase()}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center w-full h-full">
          <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white text-base font-medium">
            {(name || '?').charAt(0).toUpperCase()}
          </div>
        </div>
      )}
      {/* name + mic-off overlay */}
      <div className={`absolute bottom-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/50 text-white text-[10px] ${fontClass || ''}`}>
        {!micOn && (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        )}
        <span className={prominent ? 'font-medium' : ''}>{name}</span>
      </div>
    </div>
  );
}

/** Footer toolbar button — square-ish, active state highlights (e.g. muted = red-tinted). */
function ToolbarButton({
  label, active, tc, onClick, children, disabled,
}: {
  label: string;
  active?: boolean;
  tc: ReturnType<typeof getCallTheme>;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={label}
      className={`flex items-center gap-1.5 px-3 py-2 ${tc.rounded} ${tc.fontClass} text-xs transition-colors ${
        disabled
          ? `${tc.inactivePillBg} ${tc.text} opacity-40 cursor-not-allowed`
          : active
            ? 'bg-red-500/15 text-red-500 hover:opacity-80'
            : `${tc.inactivePillBg} ${tc.text} hover:opacity-80`
      }`}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
