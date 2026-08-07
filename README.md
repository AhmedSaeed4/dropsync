# DropSync

A secure, temporary file-sharing and collaboration app. Drop files, text, drawings, or start a live call on one device and pick them up on another — or collaborate with others in shared, encrypted workspaces. Everything is ephemeral by design: drops expire on a schedule you choose, and files are encrypted in the browser before they ever leave your device.

**Live app:** [drag-drop-app.vercel.app](https://drag-drop-app.vercel.app) — **AI agent backend:** [AhmedSaeed4/dropsync-agent](https://github.com/AhmedSaeed4/dropsync-agent)

## Features

**Drops** — Text snippets · File uploads (drag & drop, click, or clipboard paste) · Excalidraw drawings · Voice-to-text (Groq Whisper) · In-app reminders · Locked drops · Pinned drops · Multi-category organization

**Workspaces** — Shared encrypted spaces · 6-character invite codes · Owner/member roles · Group chat with quote-reply, editing, @mentions, #drop chips, read receipts, typing indicators, and presence

**Live calls** — LiveKit-powered group calling (desktop) · Up to 4 participants · Screen sharing · 30-minute daily per-person limit (trusted users exempt)

**AI assistant** — Chat with an AI agent over your drops (search, create, delete, stats, previews). Password-category drops are kept out of its reach.

**Sharing** — Public view-only share links with auto-expiry, video player, and download

**Everyday UX** — Two layouts (Classic + Editorial) · Three themes (Light/Dark/Minimal) · 30-second delete undo · Bulk select/move/copy/delete · Saved paths scratchpad · FCM push notifications · Email verification

---

### Drops

- **Upload** — Drag and drop files, click to browse, or Ctrl+V to paste an image directly
- **Text drops** — Markdown-capable composer with inline `#[Drop](id)` mention chips and a fullscreen editor view
- **Voice to text** — Record in the text modal or any chat composer; AI transcription via Groq Whisper (`whisper-large-v3`). Standard users get 20 clips per rolling 24h; trusted users are unlimited
- **Drawing drops** — Embedded Excalidraw canvas saved as PNG with embedded scene data, so drawings stay editable on reopen
- **Expiration** — 1h / 2h / 6h / 24h, or *forever* (forever is restricted to the trusted tier; timed drops can still be downgraded to a timed option)
- **Reminders** — In-app reminders on text drops (15m / 30m / 1h / 2h presets or custom); must fire before the drop's expiry; per-viewer glow with dismiss
- **Locking** — Workspace drops can be locked; only the creator or workspace owner can edit/move/delete/pin them
- **Pinning** — Up to 2 pinned drops per space; pinned drops sort to the top
- **Categories** — Up to 3 per drop; built-in Password and Link plus user-created custom categories; category filter pills with live counts
- **Editing** — Edit text content, name, categories, expiry, locked state, and attached images (file content is read-only)
- **Real-time** — Firestore `onSnapshot` listeners; changes appear across devices instantly
- **Preview** — Inline preview of text, images, videos (mp4/webm/ogg, streaming for binary files), text files, YouTube links, and drawings

### Workspaces

- **Create / join** — Create a workspace and share its 6-character invite code; join is enforced server-side via `/api/workspaces/join`
- **Shared encryption** — One shared AES-256 key per workspace, accessible to all members
- **Roles** — Owner (delete workspace, remove members, clear chat, transfer ownership) and members (leave anytime)
- **Move / copy** — Move or copy drops between personal space and workspaces, with automatic re-encryption and target-category resolution
- **Member management** — Kick members (invite code rotates so they can't rejoin), transfer ownership on leave, account deletion can hand workspaces to a successor

### Group Chat

- Encrypted at rest with the workspace key; real-time via Firestore
- **Quote-reply** — Reply with a quote strip; tapping it jumps to and highlights the parent message
- **Message editing** — Edit your own messages (within 24h, up to 10 edits), shown with an "(edited)" tag
- **Mentions & chips** — `#` autocompletes drops (clickable chips), `@` autocompletes members; mentions trigger FCM push + a workspace glow, and bypass mute
- **Read receipts** — "Seen by" roster per message, derived server-side
- **Typing & presence** — Live typing indicators and online/away member dots
- **`/clear`** — Workspace owners can wipe all messages with an inline confirmation
- **Notifications** — FCM push (production) + foreground browser notifications; mute toggle in Settings; iOS Safari unsupported

### Live Calls (desktop-only)

- LiveKit rooms managed by server-side API routes; call drops appear pinned at the top of the drop list with a LIVE badge
- Up to **4 participants**; mute, camera, screen share, fullscreen, and minimize (call keeps running minimized as a floating pill)
- **Daily time limit** — 30 minutes per person per day (UTC), enforced server-side with per-person accounting; trusted users are exempt and presence of a trusted user lifts the deadline for everyone; resets at midnight UTC
- One call per workspace at a time; capacity and limit checks happen server-side before any media permission is requested
- Phantom-call cleanup via LiveKit webhooks, stale-presence reaping, and a daily cron (`/api/call/enforce`)

### Share Links

- Generate a public view-only link for any drop with an auto-expiry
- Editorial share page (`/s/[shareId]`) with animated backgrounds, theme memory, video player, YouTube embed, copy, and download
- Reuses an existing active link when content hasn't changed; deleting the drop or share cleans up R2 assets
- Expired shares are cleaned up lazily on read and auto-deleted from R2

### Organization & Bulk Actions

- **Search** — by name/content; type `@` in a workspace search to filter by member
- **Sorting** — newest, manual (drag-and-drop reorder, persisted per space), name, size, expiry; fired reminders and pinned drops always sort first
- **Bulk select** — multi-select with bulk move, copy, and delete
- **Undo delete** — single-drop deletes get a 30-second undo toast with a live countdown

### Accounts

- **Sign-in** — Google or email/password (email users must verify their address first)
- **Settings** — display name, password reset, layout toggle, theme, chat-notification mute, magnetic footer toggle
- **Account deletion** — full flow with preview, re-authentication, and workspace ownership transfer
- **ToS consent** — clickwrap gate with versioning (`CURRENT_TERMS_VERSION`)
- **Admin dashboard** — `/admin` (owner-only) manages the trusted tier, which unlocks forever drops and unlimited call/voice usage

### UI & Themes

- **Editorial layout** (default) — clean, editorial design with pill buttons and rounded cards
- **Classic layout** — original card-style drop list
- **Three themes** — Light, Dark, Minimal (sage green), persisted per-user with a no-flash pre-paint script
- **Magnetic footer** — Lenis smooth scroll with a dissolve/magnet page footer (desktop wide screens; can be hidden from Settings)
- **Pages** — `/docs` user guide, `/about`, `/privacy`, `/terms`, `/admin`

## Security & Encryption

- **Client-side AES-256-GCM** — all text drops and files under 10 MB are encrypted in the browser before upload; the server never sees plaintext
- **Key management** — ECDH P-256 key pairs; the master key lives in IndexedDB with a Firestore backup for cross-device recovery; workspace drops use a shared workspace key
- **Large files** — 10 MB+ files are stored unencrypted for performance (HTTPS protects them in transit); the UI marks every drop ENCRYPTED / UNENCRYPTED
- **Chat encryption** — group chat messages are encrypted with the workspace key; the server only sees plaintext metadata (sender, timestamp)
- **Password drops & the AI** — password-category drops are excluded from the AI agent's reach
- **Server-side enforcement** — ownership/membership verified for every R2 delete, share, and call operation; invite-code joins, call limits, and forever-drop eligibility are all enforced on the server, not just in the UI

> **Note:** encryption protects data in transit and at rest on the server, but keys are backed up with your account — DropSync is not a zero-knowledge system (see the in-app Privacy page for the full details).

## Limits

| Limit | Value |
|-------|-------|
| Max file size | 500 MB per file |
| Encrypted threshold | Files under 10 MB are encrypted; 10 MB+ are not |
| Expiration options | 1h / 2h / 6h / 24h / forever (trusted tier) |
| Categories per drop | 3 |
| Pinned drops per space | 2 |
| Call participants | 4 |
| Call time | 30 min/day/person (trusted exempt), UTC |
| Voice transcription | 20 clips / rolling 24h (trusted unlimited), 2 MB per clip |
| Group chat history | latest 200 messages |
| Message editing | own messages, ≤ 24h old, ≤ 10 edits |

## Tech Stack

- **Framework** — Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- **Backend services** — Firebase (Auth, Firestore, FCM), Cloudflare R2 (S3-compatible file storage)
- **Live calls** — LiveKit (client + server SDKs)
- **Drawings** — Excalidraw
- **Transcription** — Groq Whisper `whisper-large-v3`
- **AI agent** — separate FastAPI backend (OpenAI Agents SDK); the frontend connects via `NEXT_PUBLIC_AGENT_URL`
- **Animations & scroll** — motion, Lenis smooth scroll, dnd-kit (drag-sort)
- **Markdown** — react-markdown + remark-breaks (AI chat rendering)

## Repository Structure

```
src/
├── app/                    # App Router pages + all API routes
│   ├── api/                #   27 server routes (admin, call, share, upload, …)
│   ├── s/[shareId]/        #   public share page
│   ├── about/ docs/ privacy/ terms/ admin/
│   └── page.tsx            #   main app (auth gate, drops, preview, calls, chat)
├── components/             # Classic-layout UI (drop list, modals, chat, settings…)
│   ├── editorial/          # Editorial-layout mirrors of the same features
│   ├── layouts/            # ClassicLayout + EditorialLayout shells
│   ├── call/               # LiveKit call UI (start screen, modal, drop tile, pill)
│   └── share/              # Public share-page components
├── hooks/                  # useAuth, useDrops, useWorkspaces, useLiveKitCall, …
└── lib/                    # crypto, keys, drops, workspaces, groupChat, shares, …
```

Most UI changes must be applied to **both** layouts (`src/components/...` and `src/components/editorial/...`) to keep them in parity.

## Getting Started

### Prerequisites

- Node.js 20.9+ (Next.js 16 requirement)
- A Firebase project with Auth (Google + Email/Password) and Firestore enabled
- A Cloudflare account with an R2 bucket
- Optional: a LiveKit project for live calls

### Installation

```bash
git clone https://github.com/AhmedSaeed4/dropsync.git
cd dropsync
npm install
```

### Environment Variables

Create `.env.local`:

```env
# ── Firebase client SDK (browser) ──────────────────────────────
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
# Required by the Firebase SDK, but DropSync stores files in Cloudflare R2 — not Firebase Storage
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

# ── Firebase Admin SDK (server-side API routes) ────────────────
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nyour_private_key\n-----END PRIVATE KEY-----\n"

# ── Cloudflare R2 storage ──────────────────────────────────────
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://pub-xxxxx.r2.dev

# ── Voice transcription (Groq Whisper) ─────────────────────────
GROQ_API_KEY=your_groq_api_key

# ── Live calls (LiveKit) ───────────────────────────────────────
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret

# ── Push notifications (FCM web push) ──────────────────────────
NEXT_PUBLIC_VAPID_KEY=your_vapid_public_key

# ── AI agent backend (separate repo, default http://localhost:8000) ──
NEXT_PUBLIC_AGENT_URL=http://localhost:8000

# ── Cron guard (production; protects /api/call/enforce) ────────
CRON_SECRET=your_cron_secret
```

The AI agent backend runs separately (default `http://localhost:8000`). The frontend connects to it via `NEXT_PUBLIC_AGENT_URL` for the in-app AI chat.

### Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Available scripts:

- `npm run dev` — development server
- `npm run build` — production build
- `npm run start` — start the production server
- `npm run lint` — run ESLint (repo has a known pre-existing lint baseline; lint changed files only)

## Firebase Setup

1. Create a new Firebase project
2. Enable Google Sign-In and Email/Password in Authentication
3. Create a Firestore database
4. Generate Admin SDK credentials:
   - Go to Project Settings → Service Accounts
   - Click "Generate new private key"
   - Copy `client_email` and `private_key` to your `.env.local`
5. Deploy security rules and indexes:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```
6. Set `config/owner` document with the owner's `uid` (field `uid`) — required for the admin dashboard, trusted-tier checks, and call-limit exemptions

> **Note:** DropSync uses Firebase only for Auth, Firestore, and FCM. Files are stored in Cloudflare R2 (configured below). The `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` value is required by the Firebase client SDK but is not used for file uploads/downloads.

## Cloudflare R2 Setup

1. Create a Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to R2 and create a new bucket (e.g., `dropsync-files`)
3. Generate R2 API tokens:
   - Go to R2 → Manage R2 API Tokens
   - Create a token with "Object Read & Write" permissions
   - Copy the Access Key ID and Secret Access Key
4. Enable public access on your bucket:
   - Go to bucket Settings
   - Click "Allow Access" under Public access
   - Copy the Public Development URL (e.g., `https://pub-xxxxx.r2.dev`)
5. Configure CORS on your bucket:
   - Go to bucket Settings → CORS Policy
   - Add this policy:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   `DELETE` is not required here — file deletes are performed server-side through the Next.js `/api/delete` route, not directly from the browser to R2.

## Shared Workspaces

1. Click the workspace selector in the header
2. Select "Create Workspace" and enter a name
3. Share the 6-character invite code with others (click the link icon to copy)
4. Others can join via "Join Workspace" and enter the code
5. All workspace members see the same drops in real-time

**Workspace management:**

- **Owners** can delete workspaces, remove members (rotating the invite code), clear the chat, and copy invite codes
- **Members** can leave workspaces
- All workspace drops and chat messages are encrypted with the shared workspace key
- Moving/copying drops between spaces re-encrypts them automatically

## Deployment

Auto-deploys to Vercel on push to `main`. The daily cron (`/api/call/enforce`) is declared in `vercel.json` and requires the `CRON_SECRET` environment variable in Vercel.

To add an environment variable to Vercel:

```bash
echo "y" | npx vercel env add <KEY> production <<< "<value>"
```

## API Routes

All routes live under `src/app/api/` and authenticate via Firebase ID tokens (Bearer), with the server deriving the caller's uid — never trusting a body-provided uid:

| Group | Routes | Purpose |
|-------|--------|---------|
| `admin/` | `list-users`, `migrate-profiles`, `migrate-public-keys` | Owner-only user lookup and one-time data backfills |
| `call/` | `start`, `confirm`, `join`, `leave`, `token`, `sync`, `access`, `enforce` (cron), `webhook`, `reap-stale` | LiveKit call lifecycle, roster admission (max 4), 30-min/day time-limit billing, phantom-call cleanup |
| `share/` | `GET/POST/PUT/DELETE /api/share`, `active`, `download`, `sync-expiry` | Share-link CRUD, R2 asset upload/download, expiry sync |
| `notify-*` | `notify-chat-message`, `notify-mention` | FCM push for group chat and @mentions (mute-aware) |
| Uploads | `presign`, `upload`, `delete` | R2 presigned PUT (binary), legacy encrypted proxy upload, ownership-checked R2 deletes |
| `transcribe` | — | Groq Whisper transcription with a per-user daily quota |
| `chat-seen-by` | — | Server-derived "read by" roster for a message |
| `workspaces/join` | — | Server-side invite-code enforcement |
| `cleanup-*` | `cleanup-fcm-tokens`, `cleanup-workspace-key` | Owner-scoped token cleanup and workspace-key removal |

## Firestore Data Model

| Collection | Purpose |
|------------|---------|
| `users/{uid}` | Self/owner-only account doc (email, tier, prefs, FCM tokens subcollection, mentions) |
| `profiles/{uid}` | World-readable display name / photo URL |
| `userKeys/{uid}`, `userPublicKeys/{uid}` | ECDH public/private key material (private key encrypted with the master key) |
| `workspaces/{id}` | Workspace metadata; subcollections: `messages`, `readState`, `typing`, `presence` |
| `workspaceKeys/{id}` | Shared workspace AES key (encrypted with a member-accessible secret) |
| `drops/{id}` | Drops (text/file/call); call drops use deterministic `call-{workspaceId}` ids |
| `categories/{id}` | Custom categories (personal or per-workspace) |
| `shares/{id}` | Public share links with expiry |
| `chats/{uid}/conversations/{id}/messages` | AI-assistant conversation history |
| `voiceUsage/{uid}`, `callUsage/{uid}` | Daily voice-transcription and call-time accounting |
| `config/owner` | Owner uid (admin, trusted tier) |

## License

MIT
