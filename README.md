# DropSync

A secure, temporary file sharing app. Drop files on one device, pick them up on another. Simple, secure, and ephemeral.

## Features

- **Drag & Drop** - Upload files or paste text instantly
- **Cross-Device Sync** - Access your drops from any device
- **Google Authentication** - Secure sign-in with Google
- **Custom Expiration** - Choose when drops expire: 1h, 2h, 6h, 24h, or keep forever
- **Shared Workspaces** - Create workspaces, invite others with a code, collaborate on drops together
- **Real-Time Updates** - See changes instantly across devices
- **Three Themes** - Light (Operational Intelligence), Dark, and Minimal

## Limits

- Maximum 50 drops per user/workspace
- 800KB max file size

## Tech Stack

- **Frontend**: Next.js 16, React, TypeScript, Tailwind CSS
- **Backend**: Firebase (Auth, Firestore)
- **Real-time**: Firestore onSnapshot listeners

## Getting Started

### Prerequisites

- Node.js 18+
- Firebase project with Auth and Firestore enabled

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

3. Create `.env.local` with your Firebase config
```
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

4. Run the development server
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

## Firebase Setup

1. Create a new Firebase project
2. Enable Google Sign-In in Authentication
3. Create a Firestore database
4. Deploy security rules:
   ```bash
   firebase deploy --only firestore:rules
   ```
5. Copy your web app config to `.env.local`

## Shared Workspaces

Workspaces allow multiple users to collaborate on the same drops:

1. Click the workspace selector in the header
2. Select "Create Workspace" and enter a name
3. Share the 6-character invite code with others
4. Others can join via "Join Workspace" and enter the code
5. All workspace members see the same drops in real-time

Personal drops remain separate from workspace drops.

## Themes

| Theme | Description |
|-------|-------------|
| **Light** | Operational Intelligence design with coral accents (#FF5A47), bold monospace typography |
| **Dark** | Dark mode with black background (#0D0D0D), white text |
| **Minimal** | Editorial style with sage green (#C5C9B8), sans-serif, pill buttons, rounded corners |

## License

MIT