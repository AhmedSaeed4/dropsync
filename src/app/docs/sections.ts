/**
 * Single source of truth for the `/docs` table-of-contents + content structure.
 * `DocsSidebar` (desktop aside + mobile dropdown), `DocsContent`, and `useScrollSpy`
 * ALL derive their anchors/titles/order from `docsSections`, so the scroll-spy highlight,
 * the click-to-scroll targets, and the section `<h2>/<h3>` ids can NEVER drift apart.
 *
 * HEADER_OFFSET is the sticky-header height (px) consumed in FOUR places — keep them aligned:
 *   1. sticky `<aside>` `top-24`              (Tailwind 6rem = 96px)
 *   2. each `<section>`/`<h3>` `scroll-mt-24` (Tailwind 6rem = 96px)
 *   3. DocsSidebar `lenis.scrollTo(el, { offset: -HEADER_OFFSET })`
 *   4. useScrollSpy IntersectionObserver `rootMargin` top band `${-HEADER_OFFSET}px ...`
 * If you change this number, also update the two Tailwind classes (`top-24`/`scroll-mt-24`) to
 * the matching Tailwind spacing step (6rem↔96px↔`*-24`). Browser-measuring the real rendered
 * header is the ideal source; 96px is the spec default (≈ sticky header + breathing gap) — under
 * the project's static-trace (no-browser) rule we can't measure, so 96 it is, kept consistent.
 */
export const HEADER_OFFSET = 96;

export type DocsSubsection = { anchor: string; title: string };
export type DocsSection = {
  anchor: string;
  title: string;
  /** Small uppercase label rendered above the H2 (editorial eyebrow). */
  eyebrow: string;
  subsections: DocsSubsection[];
};

// Anchors are url-safe kebab-case. They become the `#hash` targets, the `<section>/<h3>` ids, and
// the IntersectionObserver subjects — every one of those reads from THIS array.
export const docsSections: DocsSection[] = [
  {
    anchor: 'getting-started',
    title: 'Getting started',
    eyebrow: 'Start here',
    subsections: [
      { anchor: 'what-is-dropsync', title: 'What is DropSync?' },
      { anchor: 'sign-in', title: 'Sign in' },
      { anchor: 'home-screen', title: 'The home screen' },
      { anchor: 'themes-and-layouts', title: 'Themes & layouts' },
    ],
  },
  {
    anchor: 'drops',
    title: 'Drops',
    eyebrow: 'Your content',
    subsections: [
      { anchor: 'create-a-text-drop', title: 'Create a text drop' },
      { anchor: 'upload-files', title: 'Upload files' },
      { anchor: 'draw-a-drop', title: 'Draw a drop' },
      { anchor: 'voice-to-text', title: 'Voice-to-text' },
      { anchor: 'categories', title: 'Categories' },
      { anchor: 'pin-edit-move', title: 'Pin, edit, move, copy, delete' },
      { anchor: 'expiry', title: 'Expiry & auto-destroy' },
      { anchor: 'forever-storage', title: '“Forever” storage' },
      { anchor: 'locked-drops', title: 'Locked drops' },
      { anchor: 'personal-backup', title: 'Personal backup' },
    ],
  },
  {
    anchor: 'sharing',
    title: 'Sharing & pickup',
    eyebrow: 'Send & receive',
    subsections: [
      { anchor: 'create-a-share-link', title: 'Create a share link' },
      { anchor: 'the-pickup-page', title: 'The pickup page' },
      { anchor: 'link-expiry-and-reuse', title: 'Link expiry & reuse' },
      { anchor: 'share-link-safety', title: 'Share-link safety' },
    ],
  },
  {
    anchor: 'workspaces',
    title: 'Workspaces & members',
    eyebrow: 'Collaborate',
    subsections: [
      { anchor: 'personal-vs-workspaces', title: 'Personal space vs workspaces' },
      { anchor: 'create-a-workspace', title: 'Create a workspace & invite codes' },
      { anchor: 'join-a-workspace', title: 'Join' },
      { anchor: 'roles-and-ownership', title: 'Roles & owner actions' },
      { anchor: 'backup-and-restore', title: 'Backup & restore' },
      { anchor: 'leave-or-be-removed', title: 'Leave or be removed' },
    ],
  },
  {
    anchor: 'group-chat',
    title: 'Group chat',
    eyebrow: 'Talk it through',
    subsections: [
      { anchor: 'send-reply-edit', title: 'Send, reply, edit, delete' },
      { anchor: 'mentions-and-drop-chips', title: 'Mentions & drop chips' },
      { anchor: 'read-receipts', title: 'Read receipts' },
      { anchor: 'presence-and-typing', title: 'Presence & typing' },
      { anchor: 'clear-the-chat', title: 'Clear the chat' },
    ],
  },
  {
    anchor: 'notifications',
    title: 'Notifications',
    eyebrow: 'Stay in the loop',
    subsections: [
      { anchor: 'desktop-and-push', title: 'Desktop & push' },
      { anchor: 'mute-and-permissions', title: 'Mute & permissions' },
      { anchor: 'tap-to-open', title: 'Tap to open' },
    ],
  },
  {
    anchor: 'ai-assistant',
    title: 'The AI assistant',
    eyebrow: 'Your drops, on command',
    subsections: [
      { anchor: 'chat-with-the-assistant', title: 'Chat' },
      { anchor: 'what-it-can-do', title: 'What the agent can do' },
    ],
  },
  {
    anchor: 'security',
    title: 'Security & privacy',
    eyebrow: 'How it’s protected',
    subsections: [
      { anchor: 'encryption', title: 'Encryption' },
      { anchor: 'keys-personal-and-workspace', title: 'Personal vs workspace keys' },
      { anchor: 'invite-codes-and-share-links', title: 'Invite codes & share links' },
      { anchor: 'data-retention', title: 'Data retention' },
      { anchor: 'delete-your-account', title: 'Deleting your account' },
    ],
  },
  {
    anchor: 'settings',
    title: 'Settings & appearance',
    eyebrow: 'Make it yours',
    subsections: [
      { anchor: 'profile-and-password', title: 'Profile & password' },
      { anchor: 'layout-and-theme', title: 'Layout & theme' },
      { anchor: 'magnetic-footer', title: 'Magnetic footer & Hide footer' },
      { anchor: 'saved-paths', title: 'Saved paths' },
    ],
  },
];
