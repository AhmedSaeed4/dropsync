/**
 * Client-side encryption utilities using Web Crypto API
 * AES-256-GCM for symmetric encryption (data)
 * ECDH for key exchange (workspace members)
 * IndexedDB for secure key storage (non-extractable keys)
 */

const DB_NAME = 'dropsync_keys';
const DB_VERSION = 1;
const MASTER_KEY_STORE = 'master_keys';

// Open IndexedDB connection
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(MASTER_KEY_STORE)) {
        db.createObjectStore(MASTER_KEY_STORE);
      }
    };
  });
}

// Store a CryptoKey in IndexedDB (non-extractable)
async function storeKeyInIndexedDB(userId: string, key: CryptoKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MASTER_KEY_STORE, 'readwrite');
    const store = transaction.objectStore(MASTER_KEY_STORE);
    const request = store.put(key, userId);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Retrieve a CryptoKey from IndexedDB
async function getKeyFromIndexedDB(userId: string): Promise<CryptoKey | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MASTER_KEY_STORE, 'readonly');
    const store = transaction.objectStore(MASTER_KEY_STORE);
    const request = store.get(userId);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

// Delete a CryptoKey from IndexedDB
async function deleteKeyFromIndexedDB(userId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(MASTER_KEY_STORE, 'readwrite');
    const store = transaction.objectStore(MASTER_KEY_STORE);
    const request = store.delete(userId);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Generate a random AES key for encrypting data
export async function generateAESKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

// Generate an ECDH key pair for key exchange
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['deriveKey', 'deriveBits']
  );
}

// Export a key to base64 string
export async function exportKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(exported);
}

// Export a public key to base64 (for sharing)
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(exported);
}

// Export a private key to base64 (encrypted storage)
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('pkcs8', key);
  return arrayBufferToBase64(exported);
}

// Import an AES key from base64
export async function importAESKey(keyData: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    base64ToArrayBufferForCrypto(keyData),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Import a public key from base64
export async function importPublicKey(keyData: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'spki',
    base64ToArrayBufferForCrypto(keyData),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

// Import a private key from base64
export async function importPrivateKey(keyData: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBufferForCrypto(keyData),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

// Derive a shared secret key using ECDH
export async function deriveSharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  return await crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// Encrypt data with AES-GCM
export async function encryptData(
  data: string,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: arrayBufferToBase64(encrypted),
    iv: uint8ArrayToBase64(iv),
  };
}

// Decrypt data with AES-GCM
export async function decryptData(
  encryptedData: string,
  key: CryptoKey,
  iv: string
): Promise<string> {
  const decoder = new TextDecoder();

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToArrayBufferForCrypto(iv),
    },
    key,
    base64ToArrayBufferForCrypto(encryptedData)
  );

  return decoder.decode(decrypted);
}

// Encrypt an AES key with a shared secret (for key wrapping)
export async function encryptKey(
  dek: CryptoKey,
  sharedKey: CryptoKey
): Promise<{ encryptedKey: string; iv: string }> {
  const exportedDEK = await crypto.subtle.exportKey('raw', dek);
  const dekBase64 = arrayBufferToBase64(exportedDEK);

  const { encrypted, iv } = await encryptData(dekBase64, sharedKey);
  return { encryptedKey: encrypted, iv };
}

// Decrypt an AES key with a shared secret
export async function decryptKey(
  encryptedDEK: string,
  sharedKey: CryptoKey,
  iv: string
): Promise<CryptoKey> {
  const dekBase64 = await decryptData(encryptedDEK, sharedKey, iv);
  return await importAESKey(dekBase64);
}

// Helper: ArrayBuffer to Base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper: Uint8Array to Base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper: Base64 to ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Helper: Base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Helper: Base64 to ArrayBuffer (for Web Crypto API)
function base64ToArrayBufferForCrypto(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

// Derive a key from a password (for encrypting user's private key)
export async function deriveKeyFromPassword(
  password: string,
  salt: string
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// Generate a random password for key storage
export function generateRandomPassword(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return arrayBufferToBase64(array.buffer);
}

// Generate a non-extractable AES key for secure storage
export async function generateNonExtractableAESKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // NOT extractable - cannot be exported
    ['encrypt', 'decrypt']
  );
}

// Store master key in IndexedDB (non-extractable, secure)
export async function storeMasterKeySecurely(userId: string, key: CryptoKey): Promise<void> {
  await storeKeyInIndexedDB(userId, key);
}

// Retrieve master key from IndexedDB
export async function getMasterKeySecurely(userId: string): Promise<CryptoKey | null> {
  return await getKeyFromIndexedDB(userId);
}

// Check if master key exists in IndexedDB
export async function hasMasterKey(userId: string): Promise<boolean> {
  const key = await getKeyFromIndexedDB(userId);
  return key !== null;
}

// Delete master key from IndexedDB
export async function deleteMasterKey(userId: string): Promise<void> {
  await deleteKeyFromIndexedDB(userId);
}