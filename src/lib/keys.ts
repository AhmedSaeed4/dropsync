/**
 * Key management for end-to-end encryption
 * Handles user key pairs, storage, and key exchange for workspaces
 * Uses IndexedDB for secure non-extractable key storage
 */

import {
  doc,
  setDoc,
  getDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  generateKeyPair,
  generateAESKey,
  generateNonExtractableAESKey,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  deriveSharedKey,
  encryptKey,
  decryptKey,
  encryptData,
  decryptData,
  storeMasterKeySecurely,
  getMasterKeySecurely,
  hasMasterKey,
} from './crypto';

const KEYS_COLLECTION = 'userKeys';

export interface UserKey {
  userId: string;
  publicKey: string; // Base64 encoded SPKI
  encryptedPrivateKey: string; // Encrypted with user's master key
  iv: string; // IV for private key encryption
  createdAt: Date;
}

// Initialize user's encryption keys
// Called on first login when encryption is enabled
export async function initializeUserKeys(userId: string): Promise<{
  keyPair: CryptoKeyPair;
  masterKey: CryptoKey;
}> {
  // Generate a new key pair
  const keyPair = await generateKeyPair();

  // Generate a NON-EXTRACTABLE master key for secure storage in IndexedDB
  const masterKey = await generateNonExtractableAESKey();

  // Export and encrypt the private key
  const privateKeyData = await exportPrivateKey(keyPair.privateKey);
  const { encrypted: encryptedPrivateKey, iv } = await encryptData(privateKeyData, masterKey);

  // Export public key
  const publicKeyData = await exportPublicKey(keyPair.publicKey);

  // Store in Firestore
  await setDoc(doc(db, KEYS_COLLECTION, userId), {
    userId,
    publicKey: publicKeyData,
    encryptedPrivateKey,
    iv,
    createdAt: new Date(),
  });

  // Store master key in IndexedDB (non-extractable, secure)
  await storeMasterKeySecurely(userId, masterKey);

  return { keyPair, masterKey };
}

// Get user's key pair
export async function getUserKeys(userId: string): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
} | null> {
  // Get stored key data from Firestore
  const docRef = doc(db, KEYS_COLLECTION, userId);
  const docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    return null;
  }

  const data = docSnap.data() as UserKey;

  // Get master key from IndexedDB (non-extractable)
  const masterKey = await getMasterKeySecurely(userId);

  if (!masterKey) {
    console.error('Master key not found in IndexedDB');
    return null;
  }

  // Decrypt private key using the non-extractable master key
  const privateKeyData = await decryptData(data.encryptedPrivateKey, masterKey, data.iv);
  const privateKey = await importPrivateKey(privateKeyData);
  const publicKey = await importPublicKey(data.publicKey);

  return { publicKey, privateKey };
}

// Get just the public key for a user (for encryption)
export async function getUserPublicKey(userId: string): Promise<CryptoKey | null> {
  const docRef = doc(db, KEYS_COLLECTION, userId);
  const docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    return null;
  }

  const data = docSnap.data() as UserKey;
  return await importPublicKey(data.publicKey);
}

// Get public keys for multiple users (for workspace encryption)
export async function getUserPublicKeys(userIds: string[]): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();

  for (const userId of userIds) {
    const key = await getUserPublicKey(userId);
    if (key) {
      keys.set(userId, key);
    }
  }

  return keys;
}

// Encrypt a DEK for a specific user
export async function encryptDEKForUser(
  dek: CryptoKey,
  targetPublicKey: CryptoKey,
  senderPrivateKey: CryptoKey
): Promise<{ encryptedDEK: string; iv: string }> {
  // Derive shared secret
  const sharedKey = await deriveSharedKey(senderPrivateKey, targetPublicKey);

  // Encrypt the DEK with the shared secret
  const { encryptedKey, iv } = await encryptKey(dek, sharedKey);
  return { encryptedDEK: encryptedKey, iv };
}

// Decrypt a DEK using your private key
export async function decryptDEKForUser(
  encryptedDEK: string,
  iv: string,
  senderPublicKey: CryptoKey,
  receiverPrivateKey: CryptoKey
): Promise<CryptoKey> {
  // Derive shared secret
  const sharedKey = await deriveSharedKey(receiverPrivateKey, senderPublicKey);

  // Decrypt the DEK
  return await decryptKey(encryptedDEK, sharedKey, iv);
}

// Encrypt DEK for all workspace members
export async function encryptDEKForWorkspace(
  dek: CryptoKey,
  memberIds: string[],
  creatorPrivateKey: CryptoKey
): Promise<{ [userId: string]: { encryptedDEK: string; iv: string } }> {
  const encryptedDEKs: { [userId: string]: { encryptedDEK: string; iv: string } } = {};

  for (const memberId of memberIds) {
    const publicKey = await getUserPublicKey(memberId);
    if (publicKey) {
      const encrypted = await encryptDEKForUser(dek, publicKey, creatorPrivateKey);
      encryptedDEKs[memberId] = encrypted;
    }
  }

  return encryptedDEKs;
}

// Check if user has encryption keys set up in Firestore
export async function hasUserKeys(userId: string): Promise<boolean> {
  const docRef = doc(db, KEYS_COLLECTION, userId);
  const docSnap = await getDoc(docRef);
  return docSnap.exists();
}

// Check if user has master key stored in IndexedDB
export async function hasLocalMasterKey(userId: string): Promise<boolean> {
  return await hasMasterKey(userId);
}