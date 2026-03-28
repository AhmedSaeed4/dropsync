# DropSync

A secure, temporary file sharing app. Drop files on one device, pick them up on another. Simple, secure, and ephemeral.

## Features

- **Drag & Drop** - Upload files or paste text instantly
- **Cross-Device Sync** - Access your drops from any device
- **Multiple Auth Options** - Sign in with Google or Email/Password with email verification
- **End-to-End Encryption** - Client-side encryption for text and files under 10MB using AES-GCM
- **Smart Encryption** - Files over 10MB are stored without encryption for performance (HTTPS still secures transit)
- **Workspace Encryption** - Shared workspace key allows all members to encrypt/decrypt workspace drops
- **Custom Expiration** - Choose when drops expire: 1h, 2h, 6h, 24h, or keep forever
- **Shared Workspaces** - Create workspaces, invite others with a code, collaborate on drops together
- **Workspace Management** - Owners can delete workspaces, members can leave
- **Real-Time Updates** - See changes instantly across devices
- **Three Themes** - Light (Operational Intelligence), Dark, and Minimal
- **Cloudflare R2 Storage** - Files stored securely in R2 with 50MB max size

## Limits

- Maximum 50 drops per user/workspace
- 500MB max file size
- Files under 10MB are encrypted, 10MB+ files are not encrypted (for performance)
- 10GB free storage (Cloudflare R2 free tier)

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **Backend**: Firebase (Auth, Firestore)
- **File Storage**: Cloudflare R2 (S3-compatible)
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
```

4. Run the development server
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

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
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

## Shared Workspaces

Workspaces allow multiple users to collaborate on the same drops:

1. Click the workspace selector in the header
2. Select "Create Workspace" and enter a name
3. Share the 6-character invite code with others (click the link icon to copy)
4. Others can join via "Join Workspace" and enter the code
5. All workspace members see the same drops in real-time

**Workspace Management:**
- **Owners** can delete workspaces (trash icon) and copy invite codes (link icon)
- **Members** can leave workspaces (exit icon)
- All workspace drops are encrypted with a shared workspace key

Personal drops remain separate from workspace drops and use individual encryption.

## Security

- **End-to-End Encryption**: Files under 10MB and all text drops are encrypted client-side before upload using AES-256-GCM
- **Large File Handling**: Files 10MB and larger are uploaded without encryption for performance, but remain secure in transit via HTTPS
- **Workspace Keys**: Shared encryption keys for workspace collaboration
- **API Authentication**: Firebase ID tokens required for all R2 operations
- **Ownership Verification**: Delete API verifies user owns the drop before deletion
- **Visual Indicators**: Each file displays its encryption status (🔒 Encrypted / 🔓 Unencrypted)

## Themes

| Theme | Description |
|-------|-------------|
| **Light** | Operational Intelligence design with coral accents (#FF5A47), bold monospace typography |
| **Dark** | Dark mode with black background (#0D0D0D), white text |
| **Minimal** | Editorial style with sage green (#C5C9B8), sans-serif, pill buttons, rounded corners |

## License

MIT