import type { ReactNode } from 'react';
import { docsSections } from './sections';

/**
 * The `/docs` body — editorial prose for every section. A SERVER component (no client JS).
 *
 * STRUCTURE vs CONTENT split: the `<section>`/`<h3>` ids, titles, eyebrows, and ORDER come from
 * `docsSections` (sections.ts — the single source of truth shared with DocsSidebar + useScrollSpy).
 * Only the hand-written prose below lives here, keyed by anchor. So the TOC, the scroll-spy, and
 * this page can NEVER drift: add a subsection in sections.ts and it appears in the TOC and gets an
 * id automatically — just remember to add its body to `PROSE` (a missing key renders an empty
 * subsection, which the implementer's grep check catches).
 *
 * Editorial-minimal: Raleway, light/normal weights, negative tracking on headings, uppercase
 * eyebrow, hairline `border-t` dividers, `text-[15px] leading-7` body in the muted token. No
 * coral, no mono, no uppercase body, no theme button. Body uses Tailwind v4 complete literal
 * classes only. Security wording below is load-bearing (see the `encryption` subsection).
 */

const BODY = 'mt-2 max-w-[680px] text-[15px] leading-7 text-[var(--muted)]';
const SUB_HEAD = 'scroll-mt-24 text-lg font-medium tracking-tight text-[var(--text)]';

type SectionProse = { intro: ReactNode; subs: Record<string, ReactNode> };

// Per-subsection body, keyed by the SAME anchors as sections.ts. Backticks so apostrophes/quotes
// need no escaping (none of the prose contains ${ or backticks).
const PROSE: Record<string, SectionProse> = {
  'getting-started': {
    intro: (
      <p className={BODY}>
        DropSync is a secure, temporary file-sharing workspace. Drop files, text, drawings, or
        voice notes from any device; share them with a link or collaborate inside a workspace;
        and let everything clean itself up on a timer. This guide walks through every feature.
      </p>
    ),
    subs: {
      'what-is-dropsync': (
        <p className={BODY}>
          A place to move content between your own devices or hand it to someone else — without
          installs, without permanent storage, and without a file living online forever unless you
          say so. Everything you create is a drop: a text note, a file, an image, a
          drawing, or a voice transcription.
        </p>
      ),
      'sign-in': (
        <p className={BODY}>
          Sign in with Google, or create an account with an email and password (we send a
          verification email). Your personal space is created automatically on first sign-in — no
          setup required.
        </p>
      ),
      'home-screen': (
        <p className={BODY}>
          The home screen is your workspace: a drop area in the middle where you drag, paste, type,
          or pick files; your drops below it, filterable by category; and the workspace switcher,
          search, and AI assistant around the edges.
        </p>
      ),
      'themes-and-layouts': (
        <p className={BODY}>
          DropSync ships in two layouts (Classic and Editorial) and three themes (Light, Dark, and
          Minimal-sage). Switch them in Settings → Appearance; your choice is remembered on this
          device. (See Settings & appearance below for every option.)
        </p>
      ),
    },
  },

  drops: {
    intro: (
      <p className={BODY}>
        A drop is the unit of everything in DropSync. Make one from text, a file, a drawing, or your
        voice — then organize, share, or schedule it to self-destruct.
      </p>
    ),
    subs: {
      'create-a-text-drop': (
        <p className={BODY}>
          Focus the composer and start typing — a note, a link, a code snippet, a password. Save it
          and it appears in your list, encrypted and ready to share or keep private.
        </p>
      ),
      'upload-files': (
        <p className={BODY}>
          Drag one or more files onto the drop area, click to open the file picker, or paste an
          image straight from your clipboard. Each file can be up to 500 MB; an upload-progress
          indicator tracks larger transfers.
        </p>
      ),
      'draw-a-drop': (
        <p className={BODY}>
          Open the drawing tool to sketch or annotate freehand (Excalidraw). When you save, it is
          exported as a PNG image drop — handy for quick diagrams or marking up a screenshot.
        </p>
      ),
      'voice-to-text': (
        <p className={BODY}>
          Tap the microphone and speak; your audio is transcribed by Groq Whisper into editable
          text, which becomes a normal text drop you can review before saving.
        </p>
      ),
      categories: (
        <p className={BODY}>
          Tag a drop with up to three categories to keep things organized. Password and Link are
          built in, or create your own. Categories drive filtering — and
          password-category drops are kept out of the AI assistant’s reach.
        </p>
      ),
      'pin-edit-move': (
        <p className={BODY}>
          Pin a drop to keep it on top. Edit its name, content, category, expiry, or attached image
          (it is re-encrypted on save). Move it between your personal space and any workspace, copy
          it, or delete it — with a 30-second undo window if you change your mind.
        </p>
      ),
      expiry: (
        <p className={BODY}>
          Every drop has a timer: 1 hour, 2 hours, 6 hours, or 24 hours. When it expires, the drop
          and its file are deleted from storage and the database — no hidden copies, and the share
          link stops working.
        </p>
      ),
      'forever-storage': (
        <p className={BODY}>
          “Forever” keeps a drop until you (or a workspace owner) delete it. Forever storage is
          currently limited to trusted accounts and an upcoming paid tier — it is not available to
          everyone, so you may not see it as an option.
        </p>
      ),
      'locked-drops': (
        <p className={BODY}>
          A drop can be locked so only its creator or the workspace owner can change it. Members
          can still read locked drops; the lock protects editing and deletion, not visibility.
        </p>
      ),
    },
  },

  sharing: {
    intro: (
      <p className={BODY}>
        Any drop can be shared with a link. The person you send it to does not need a DropSync
        account.
      </p>
    ),
    subs: {
      'create-a-share-link': (
        <p className={BODY}>
          From any drop, choose Share to generate a unique link. Copy it and send it however you
          like — chat, email, another device. The link points at a public pickup page.
        </p>
      ),
      'the-pickup-page': (
        <p className={BODY}>
          Opening the link shows a clean pickup page: a preview of the content, plus copy and
          download actions. It adapts to light or dark and works on any modern browser with no
          sign-in.
        </p>
      ),
      'link-expiry-and-reuse': (
        <p className={BODY}>
          A share link lives as long as its drop does. When the drop expires or is deleted, the link
          stops working immediately. Links are reusable — anyone who has the link can pick up the
          drop until then.
        </p>
      ),
      'share-link-safety': (
        <p className={BODY}>
          Treat a share link like a key: anyone who has it can view the drop. To revoke access,
          delete the drop (or let it expire). Do not post share links publicly if the content is
          sensitive.
        </p>
      ),
    },
  },

  workspaces: {
    intro: (
      <p className={BODY}>
        Workspaces let a team share the same set of drops (and a group chat) under one encryption
        key.
      </p>
    ),
    subs: {
      'personal-vs-workspaces': (
        <p className={BODY}>
          Your Personal space is just you. A workspace is a shared space you own or have joined —
          its drops are encrypted with a single workspace key that all members hold, so everyone
          sees the same content.
        </p>
      ),
      'create-a-workspace': (
        <p className={BODY}>
          Create a workspace, name it, and you become its owner. You get a 6-character invite code
          (generated securely) to hand out. The workspace gets its own drops, its own chat, and its
          own members list.
        </p>
      ),
      'join-a-workspace': (
        <p className={BODY}>
          Enter a workspace’s 6-character invite code — from the sign-in screen or the workspace
          switcher — to join it. You immediately share its drops and chat.
        </p>
      ),
      'roles-and-ownership': (
        <p className={BODY}>
          Owners can delete the workspace, remove (kick) members, and leave (optionally
          transferring ownership). Kicking a member rotates the workspace’s invite code so a
          removed member cannot rejoin with the old code. All members can add and edit drops.
        </p>
      ),
      'backup-and-restore': (
        <p className={BODY}>
          Workspace owners can export a password-protected <code>.dropsync</code> backup from the
          drop-list toolbar and import it from Workspace options. The backup includes active drops,
          files, drawings, categories, display-name snapshots, reminders, locked drops, and
          password-category drops. It excludes chat, calls, expired drops, share links, invite
          codes, and encryption keys. The original workspace is never changed by export. Keep the
          password safe: DropSync cannot recover it. Restored drops receive new IDs and imported
          locked drops are owned by the importer, so their edit authority follows the importer.
          Large files remain raw binary, matching the live app&apos;s existing 10 MB+ storage behavior.
          The owner-only button is a convenience gate, not a cryptographic boundary: workspace
          members already have access to the shared workspace key and current drops.
        </p>
      ),
      'leave-or-be-removed': (
        <p className={BODY}>
          Members can leave a workspace at any time. An owner can remove a member (which rotates the
          invite code). Leaving or being removed revokes your copy of the workspace key, so you can
          no longer read its drops.
        </p>
      ),
    },
  },

  'group-chat': {
    intro: (
      <p className={BODY}>
        Every workspace has a group chat for quick conversation alongside the drops.
      </p>
    ),
    subs: {
      'send-reply-edit': (
        <p className={BODY}>
          Send messages, reply to a specific message (quoted), edit your own messages within 24
          hours, delete them, or copy them. Markdown is supported.
        </p>
      ),
      'mentions-and-drop-chips': (
        <p className={BODY}>
          @mention a member to notify them (mentions work across workspaces). Embed a drop with a{' '}
          #[drop] chip that previews the drop inline.
        </p>
      ),
      'read-receipts': (
        <p className={BODY}>
          Messages show a “Read by” roster so you can see who has seen them.
        </p>
      ),
      'presence-and-typing': (
        <p className={BODY}>
          The chat shows who is currently online and who is typing, so you know when someone is
          about to reply.
        </p>
      ),
      'clear-the-chat': (
        <p className={BODY}>
          A workspace owner can clear the chat — removing its message history for everyone.
        </p>
      ),
    },
  },

  notifications: {
    intro: (
      <p className={BODY}>
        Get notified about mentions, replies, and workspace activity without keeping the tab open.
      </p>
    ),
    subs: {
      'desktop-and-push': (
        <p className={BODY}>
          Enable desktop notifications and push (to Android and desktop browsers via FCM). Push is
          not supported on iOS Safari — there, in-app notifications apply instead.
        </p>
      ),
      'mute-and-permissions': (
        <p className={BODY}>
          You can mute a workspace or the whole app, and grant or revoke notification permissions
          from your browser or site settings at any time.
        </p>
      ),
      'tap-to-open': (
        <p className={BODY}>
          Tapping a push or desktop notification deep-links you straight to the relevant workspace
          chat.
        </p>
      ),
    },
  },

  'ai-assistant': {
    intro: (
      <p className={BODY}>
        An AI assistant can read and manage your drops for you, in plain language.
      </p>
    ),
    subs: {
      'chat-with-the-assistant': (
        <p className={BODY}>
          Open the assistant and ask questions or give instructions in chat. Answers come back as
          Markdown, and your conversation history is kept.
        </p>
      ),
      'what-it-can-do': (
        <p className={BODY}>
          The agent can list and search your drops, get or preview one, and create, move, or delete
          drops on your behalf. It only ever touches drops you can see — and it never touches
          password-category drops.
        </p>
      ),
    },
  },

  security: {
    intro: (
      <p className={BODY}>
        DropSync is built around encryption and auto-destruction. This section is precise about what
        is — and is not — protected.
      </p>
    ),
    subs: {
      // LOAD-BEARING WORDING: “in transit and at rest” only. NEVER “E2EE / zero-knowledge /
      // end-to-end encrypted” — the keys are backed up server-side so the assistant + multi-device
      // access work. Files <10 MB are client-encrypted; larger ride HTTPS only.
      encryption: (
        <p className={BODY}>
          Content is encrypted <strong>in transit</strong> (over HTTPS) and <strong>at rest</strong>.
          Text notes, files under 10 MB, images, drawings, and chat messages are encrypted in your
          browser with AES-256-GCM before they leave your device. This is encryption in transit and
          at rest — it is <strong>not</strong> end-to-end, zero-knowledge, or “E2EE”: the keys are
          also backed up with your account so you can reach your data from any device and so the AI
          assistant can act on your drops. Do not store anything in DropSync expecting that no one
          but you could ever read it.
        </p>
      ),
      'keys-personal-and-workspace': (
        <p className={BODY}>
          Personal-space drops use keys tied to you. Workspace drops use a single shared workspace
          key held by every member — so adding or removing a member changes who can read that
          workspace’s content.
        </p>
      ),
      'invite-codes-and-share-links': (
        <p className={BODY}>
          Workspace invite codes and share links are bearer secrets — long, random, and generated
          securely. Possession grants access, so share them only with people you trust, and rotate
          them (by removing a member or deleting a drop) if one leaks.
        </p>
      ),
      'data-retention': (
        <p className={BODY}>
          Drops self-destruct on their timer (1h–24h); expired content is deleted from storage and
          the database. “Forever” content stays only for trusted accounts (and paid tiers later)
          until deliberately deleted.
        </p>
      ),
      'delete-your-account': (
        <p className={BODY}>
          You can delete your account from Settings. If you own workspaces, ownership is transferred
          first. See the{' '}
          <a
            className="text-[var(--text)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--text)]"
            href="/privacy"
          >
            Privacy Policy
          </a>{' '}
          for what deletion covers.
        </p>
      ),
    },
  },

  settings: {
    intro: (
      <p className={BODY}>
        Settings covers your identity, how the app looks and feels, and a few preferences.
      </p>
    ),
    subs: {
      'profile-and-password': (
        <p className={BODY}>
          Update your display name and profile photo, and change your password (for email/password
          accounts).
        </p>
      ),
      'layout-and-theme': (
        <p className={BODY}>
          Choose your layout (Classic or Editorial) and your theme (Light, Dark, or Minimal-sage).
          Changes apply instantly and are remembered on this device.
        </p>
      ),
      'magnetic-footer': (
        <p className={BODY}>
          On wide screens (≥1400px) the Editorial layout has a magnetic footer that rises over the
          app as you scroll. If you would rather hide it, the footer has a “Hide footer” action —
          and you can bring it back from Settings → Appearance.
        </p>
      ),
      'saved-paths': (
        <p className={BODY}>
          Pin frequently used workspace or category paths for quick access from the home screen.
        </p>
      ),
    },
  },
};

export function DocsContent() {
  return (
    // PROSE is keyed by the SAME anchors as docsSections, so ids/titles/order are data-driven and
    // cannot drift from the sidebar or scroll-spy.
    <div className="pb-8">
      {docsSections.map((s) => {
        const p = PROSE[s.anchor];
        return (
          <section
            key={s.anchor}
            className="border-t border-[var(--border)] py-16 first:border-t-0"
          >
            <p className="text-[0.75rem] uppercase tracking-[0.15em] text-[var(--muted)]">{s.eyebrow}</p>
            {/* id + scroll-mt-24 live on the short <h2>, NOT the tall <section>. useScrollSpy's
                smallest-top heuristic observes these ids; if the id sat on the full-height <section>,
                that container would always have a smaller top than any nested <h3> subsection and the
                highlight would never hand off from section -> subsection as you read. The <h2> leaves
                the observer's band once it scrolls under the header, letting the in-view subsection win. */}
            <h2
              id={s.anchor}
              className="scroll-mt-24 mt-3 text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] text-[var(--text)]"
            >
              {s.title}
            </h2>
            {p?.intro}
            <div className="mt-8 space-y-8">
              {s.subsections.map((sub) => (
                <div key={sub.anchor}>
                  <h3 id={sub.anchor} className={SUB_HEAD}>
                    {sub.title}
                  </h3>
                  {p?.subs?.[sub.anchor]}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
