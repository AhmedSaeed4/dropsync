# DropSync

A secure, temporary file sharing app. Drop files on one device, pick them up on another. Simple, secure, and ephemeral.

## Features

▎ Drop Management · Drawing Drops · Pinned Drops · @Mention Filtering · Workspaces (shared encryption) · Group Chat with #drop tagging · AI Chat Assistant · Bulk Select/Move/Delete · Public Share Links · Video Support · Themes & Layouts · Desktop Notifications · Email Verification · Account Deletion

### Drop Management

- **Drag & Drop** - Upload files or paste text instantly
- **Clipboard Paste** - Copy an image and Ctrl+V to upload directly
- **Voice to Text** - Record your voice in the text modal, AI transcribes it using Groq Whisper
- **Drop Editing** - Edit existing drops (name, content, categories, expiration, attached image) with automatic re-encryption
- **Drawing Drops** - Create sketches and diagrams with an embedded Excalidraw canvas; saved as images with embedded scene data so they remain editable
- **Custom Expiration** - Choose when drops expire: 1h, 2h, 6h, 24h, or keep forever
- **Real-Time Updates** - See changes instantly across devices via Firestore onSnapshot
- **Drop Preview Modal** - View files, text, images, videos, YouTube links, and drawings inline

### Video Support

- **Video Preview** - Inline video playback in the preview modal (mp4, webm, ogg)
- **Video Thumbnails** - Drop cards show extracted thumbnail frames for videos under 10MB
- **Video Sharing** - Shared video links include a playable video player and download button

### Organization

- **Multi-Category Support** - Assign up to 3 categories per drop (was single category)
- **Built-in Categories** - Password, Link, and custom categories
- **Category Filtering** - Filter drops by category in the drop list
- **Pinned Drops** - Pin up to 2 drops per space; pinned items sort to the top of the list
- **@Mention Filtering** - Type `@` in the workspace drop search box to filter drops by workspace member
- **AI Chat Assistant** - Talk to your drops naturally — search, create, delete, get stats, and preview drops via the built-in AI agent

### Workspaces

- **Shared Workspaces** - Create workspaces, invite others with a code, collaborate on drops together
- **Workspace Encryption** - Shared workspace key allows all members to encrypt/decrypt workspace drops
- **Workspace Management** - Owners can delete workspaces, members can leave
- **Move Drops Between Workspaces** - Move individual or bulk drops between personal space and workspaces, with automatic re-encryption and image re-encryption
- **Move to Personal Space** - Move workspace drops back to personal space

### Group Chat

- **Workspace Group Chat** - Real-time chat inside every workspace, encrypted with the shared workspace key
- **Unread Counter** - Chat button lights up when new messages arrive
- **#Drop Tagging** - Type `#` in chat to reference a drop; rendered as a clickable chip that opens the drop preview
- **Desktop Notifications** - Foreground-only browser notifications for new messages (sender name + workspace name, no body)
- **Notification Controls** - One-time permission prompt on first chat open; mute/unmute toggle in Settings; iOS Safari not supported

### Selection & Bulk Actions

- **Bulk Select Mode** - Select multiple drops via checkboxes on cards
- **Bulk Move** - Move selected drops to a different workspace in one action
- **Bulk Delete** - Delete multiple selected drops at once

### Share System

- **Public Share Links** - Generate shareable links for any drop, with configurable auto-expiry
- **Share Page** - Clean editorial design with video player, image display, text rendering, and YouTube embeds
- **Share Download** - Download shared files with proper MIME type handling (handles data URL conversion from R2)
- **Automatic Cleanup** - Expired shares are auto-deleted from R2 storage

### Undo & Recovery

- **Undo Delete** - 30-second undo window after deleting a drop via toast notification
- **Saved Paths** - Personal scratchpad for saved text paths/snippets; add, copy, and delete saved strings (edit supported in Classic layout)

### Account

- **Email Verification** - Email/password users must verify their email address before signing in; resend-verification UI included
- **Account Deletion** - Full deletion flow in Settings with re-authentication and workspace ownership transfer before removal

### UI & Themes

- **Editorial Layout** (default) — Clean, modern design with white background, subtle borders, and rounded elements
- **Classic Layout** — Original layout mode with card-style drop list
- **Three Themes** — Light (default), Dark, and Minimal (sage green editorial)
- **Chat Animations** - Message entrance animations, loading diamond morph, spring bounce effects
- **Skeleton Loading** — Pulse animations while decrypting drops or loading content
- **Theme Selector** — Switch themes from the header

### Storage & Security

- **Cloudflare R2 Storage** - Files stored securely in R2 with 500MB max file size
- **End-to-End Encryption** - Client-side encryption for text and files under 10MB using AES-GCM
- **Smart Encryption** - Files over 10MB are stored without encryption for performance (HTTPS still secures transit)
- **Cross-Device Sync** - Access your drops from any device in real-time

## Limits

- Maximum 200 drops per user/workspace
- 500MB max file size (per individual file)
- Files under 10MB are encrypted, 10MB+ files are not encrypted (for performance)
- No total storage limit (10GB free on Cloudflare R2 free tier)

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **Backend**: Firebase (Auth, Firestore)
- **File Storage**: Cloudflare R2 (S3-compatible)
- **AI Agent**: [DropSync Agent](https://github.com/AhmedSaeed4/dropsync-agent) (FastAPI, OpenAI Agents SDK, MCP) — runs separately; frontend connects via `NEXT_PUBLIC_AGENT_URL`
- **Voice Transcription**: Groq Whisper Large v3
- **Drawing**: Excalidraw
- **Notifications**: Browser Notification API (foreground-only, no service worker)
- **Real-time**: Firestore onSnapshot listeners

## Getting Started

### Prerequisites

- Node.js 18+
- Firebase project with Auth and Firestore enabled
- Cloudflare account with R2 bucket

### Installation

1. Clone the repo
```bash
git clone https://github.com/AhmedSaeed4/dropsync.git
cd dropsync
```

2. Install dependencies
```bash
npm install
```

3. Create `.env.local` with your Firebase and R2 config
```
# Firebase Client SDK (browser-side)
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
# Required by the Firebase SDK, but DropSync stores files in Cloudflare R2 — not Firebase Storage
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

# Firebase Admin SDK (server-side API routes)
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nyour_private_key\n-----END PRIVATE KEY-----\n"

# Cloudflare R2 Storage
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://pub-xxxxx.r2.dev

# Voice Transcription (Groq Whisper)
GROQ_API_KEY=your_groq_api_key

# Agent Backend
NEXT_PUBLIC_AGENT_URL=http://localhost:8000
```

The AI agent backend runs separately (default `http://localhost:8000`). The frontend connects to it via `NEXT_PUBLIC_AGENT_URL` for the in-app AI chat.

4. Run the development server
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

Available scripts:
- `npm run dev` — start the development server
- `npm run build` — production build
- `npm run start` — start the production server
- `npm run lint` — run ESLint

## Firebase Setup

1. Create a new Firebase project
2. Enable Google Sign-In and Email/Password in Authentication
3. Create a Firestore database
4. Generate Admin SDK credentials:
   - Go to Project Settings → Service Accounts
   - Click "Generate new private key"
   - Copy `client_email` and `private_key` to your `.env.local`
5. Deploy security rules:
   ```bash
   firebase deploy --only firestore:rules
   ```

> **Note:** DropSync uses Firebase only for Auth and Firestore. Files are stored in Cloudflare R2 (configured below). The `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` value is required by the Firebase client SDK but is not used for file uploads/downloads.

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

Workspaces allow multiple users to collaborate on the same drops:

1. Click the workspace selector in the header
2. Select "Create Workspace" and enter a name
3. Share the 6-character invite code with others (click the link icon to copy)
4. Others can join via "Join Workspace" and enter the code
5. All workspace members see the same drops in real-time

**Workspace Management:**
- **Owners** can delete workspaces and copy invite codes
- **Members** can leave workspaces
- All workspace drops are encrypted with a shared workspace key
- **Moving drops**: Right-click or use the move button to relocate drops between personal space and workspaces (re-encrypts automatically)
- **Bulk operations**: Select multiple drops and move or delete them together

Personal drops remain separate from workspace drops and use individual encryption.

## Security

- **End-to-End Encryption**: Files under 10MB and all text drops are encrypted client-side before upload using AES-256-GCM
- **Large File Handling**: Files 10MB and larger are uploaded without encryption for performance, but remain secure in transit via HTTPS
- **Workspace Keys**: Shared encryption keys for workspace collaboration
- **Group Chat Encryption**: Workspace chat messages are encrypted with the shared workspace key
- **Chat Read State**: Stored server-side in Firestore at `workspaces/{id}/readState/{uid}` (per-user), not localStorage
- **API Authentication**: Firebase ID tokens required for all R2 operations
- **Ownership Verification**: Delete API verifies user owns the drop before deletion
- **Visual Indicators**: Each file displays its encryption status (Encrypted / Unencrypted)

## Themes

| Theme | Description |
|-------|-------------|
| **Light** | Operational Intelligence design with coral accents (#FF5A47), bold monospace typography |
| **Dark** | Dark mode with black background (#0D0D0D), white text |
| **Minimal** | Editorial style with sage green (#C5C9B8), sans-serif, pill buttons, rounded corners |

## License

MIT
