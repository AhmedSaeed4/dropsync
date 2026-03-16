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
  importAESKey,
  deriveSharedKey,
  encryptKey,
  decryptKey,
  encryptData,
  decryptData,
  exportKey,
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

// ============ WORKSPACE KEY MANAGEMENT ============

const WORKSPACE_KEYS_COLLECTION = 'workspaceKeys';

export interface WorkspaceKeyData {
  workspaceId: string;
  // Workspace key encrypted with workspace secret (base64 encoded)
  encryptedKey: string;
  iv: string;
  // The secret used to encrypt (stored here for members to access)
  keySecret: string;
  createdAt: Date;
}

// Generate a random workspace secret
function generateWorkspaceSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// Generate and store a workspace key
export async function createWorkspaceKey(
  workspaceId: string,
  creatorId: string
): Promise<boolean> {
  try {
    // Generate workspace AES key
    const workspaceKey = await generateAESKey();
    const secret = generateWorkspaceSecret();

    // Import secret as CryptoKey for encryption
    const secretKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret).slice(0, 32),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    // Export and encrypt the workspace key
    const exportedKey = await exportKey(workspaceKey);
    const encryptedData = await encryptData(exportedKey, secretKey);

    // Store in Firestore
    await setDoc(doc(db, WORKSPACE_KEYS_COLLECTION, workspaceId), {
      workspaceId,
      encryptedKey: encryptedData.encrypted,
      iv: encryptedData.iv,
      keySecret: secret,
      createdAt: new Date(),
    });

    return true;
  } catch (error) {
    console.error('Error creating workspace key:', error);
    return false;
  }
}

// Get workspace key (any member can access using the stored secret)
export async function getWorkspaceKey(
  workspaceId: string,
  userId: string
): Promise<CryptoKey | null> {
  try {
    // Get workspace key document
    const docRef = doc(db, WORKSPACE_KEYS_COLLECTION, workspaceId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) return null;

    const data = docSnap.data() as WorkspaceKeyData;

    // Import secret as CryptoKey
    const secretKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(data.keySecret).slice(0, 32),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    // Decrypt the workspace key
    const decryptedKeyData = await decryptData(data.encryptedKey, secretKey, data.iv);
    const workspaceKey = await importAESKey(decryptedKeyData);

    return workspaceKey;
  } catch (error) {
    console.error('Error getting workspace key:', error);
    return null;
  }
}

// Check if workspace has encryption key set up
export async function hasWorkspaceKey(workspaceId: string): Promise<boolean> {
  const docRef = doc(db, WORKSPACE_KEYS_COLLECTION, workspaceId);
  const docSnap = await getDoc(docRef);
  return docSnap.exists();
}

// No longer needed - workspace key is accessible via workspace secret
export async function addMemberToWorkspaceKey(
  workspaceId: string,
  newMemberId: string,
  existingMemberId: string
): Promise<boolean> {
  // Workspace key is now accessible to all members via the stored secret
  // No per-member encryption needed
  return true;
}

// No longer needed - but kept for compatibility
export async function removeMemberFromWorkspaceKey(
  workspaceId: string,
  memberId: string
): Promise<boolean> {
  // When member leaves, they lose access via Firestore rules
  // The workspace key itself doesn't need to change
  return true;
}