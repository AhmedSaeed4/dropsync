import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

// Shared Firebase Admin SDK accessor for server components / routes. Mirrors the inline init in
// src/app/api/share/route.ts (same env vars, same `if (!getApps().length)` once-guard). Existing
// /api/* routes keep their own working inline init UNTOUCHED — this is the new shared path used by
// server components (e.g. the share page's generateMetadata). Admin bypasses firestore.rules, so
// no rules change is needed to read the shares doc here.
//
// The instances are cached in module scope after first init; getFirestore()/getAuth() are
// idempotent for the default app regardless, so this is just to avoid repeated guard checks.

let dbInstance: Firestore | null = null;
let authInstance: Auth | null = null;

function ensureApp(): void {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
}

export function getAdminDb(): Firestore {
  ensureApp();
  if (!dbInstance) dbInstance = getFirestore();
  return dbInstance;
}

export function getAdminAuth(): Auth {
  ensureApp();
  if (!authInstance) authInstance = getAuth();
  return authInstance;
}
