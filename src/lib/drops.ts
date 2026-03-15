import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  query,
  where,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  getDocs
} from 'firebase/firestore';
import { db } from './firebase';
import { Drop, ExpirationOption } from '@/types';
import { generateAESKey, encryptData, decryptData, importAESKey, exportKey } from './crypto';
import {
  getUserKeys,
  getUserPublicKey,
  encryptDEKForWorkspace,
  encryptDEKForUser,
  decryptDEKForUser
} from './keys';

const DROPS_COLLECTION = 'drops';
const MAX_DROPS = 50;
const MAX_FILE_SIZE = 800 * 1024; // 800KB limit (Firestore doc limit is 1MB)

// Calculate expiration date based on option
function getExpirationDate(option: ExpirationOption): Date | null {
  if (option === 'forever') return null;

  const now = new Date();
  const hours = parseInt(option.replace('h', ''));
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export function createDropListener(
  userId: string,
  workspaceId: string | null,
  callback: (drops: Drop[]) => void
): () => void {
  // Query based on workspaceId
  // For personal drops (null), filter by userId AND workspaceId == null
  // For workspace drops, filter by workspaceId
  const q = query(
    collection(db, DROPS_COLLECTION),
    where('workspaceId', '==', workspaceId),
    limit(MAX_DROPS)
  );

  return onSnapshot(q, (snapshot) => {
    const now = new Date();
    const drops: Drop[] = [];

    snapshot.forEach((document) => {
      const data = document.data();
      const expiresAt = data.expiresAt?.toDate() || null;

      // Include drop if it has no expiration (forever) or hasn't expired yet
      if (!expiresAt || expiresAt > now) {
        drops.push({
          id: document.id,
          userId: data.userId,
          type: data.type,
          name: data.name,
          content: data.content,
          fileData: data.fileData,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
          createdAt: data.createdAt?.toDate() || new Date(),
          expiresAt: expiresAt,
          expirationOption: data.expirationOption,
          workspaceId: data.workspaceId || null,
          encrypted: data.encrypted,
          iv: data.iv,
          encryptedDEK: data.encryptedDEK,
          encryptedDEKs: data.encryptedDEKs,
        });
      }
    });

    // Sort by createdAt desc on client side
    drops.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    callback(drops);
  }, (error) => {
    console.error('Firestore listener error:', error);
    callback([]);
  });
}

export async function createTextDrop(
  userId: string,
  name: string,
  content: string,
  expirationOption: ExpirationOption = '2h',
  workspaceId: string | null = null,
  workspaceMembers?: string[]
): Promise<Drop | null> {
  try {
    const now = new Date();
    const expiresAt = getExpirationDate(expirationOption);

    let encryptedContent = content;
    let encrypted = false;
    let iv: string | undefined;
    let encryptedDEK: string | undefined;
    let encryptedDEKs: { [userId: string]: { encryptedDEK: string; iv: string } } | undefined;

    // Check if user has encryption keys
    const keys = await getUserKeys(userId);
    if (keys) {
      // Generate DEK
      const dek = await generateAESKey();

      // Encrypt content with DEK
      const encryptedData = await encryptData(content, dek);
      encryptedContent = encryptedData.encrypted;
      iv = encryptedData.iv;
      encrypted = true;

      // Encrypt DEK
      if (workspaceId && workspaceMembers && workspaceMembers.length > 0) {
        // Workspace drop - encrypt DEK for all members
        encryptedDEKs = await encryptDEKForWorkspace(dek, workspaceMembers, keys.privateKey);
      } else {
        // Personal drop - encrypt DEK with user's own key
        const publicKey = await getUserPublicKey(userId);
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek,
            publicKey,
            keys.privateKey
          );
          encryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }
      }
    }

    // Build document data, excluding undefined fields
    const docData: Record<string, unknown> = {
      userId,
      type: 'text',
      name,
      content: encryptedContent,
      createdAt: serverTimestamp(),
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      expirationOption,
      workspaceId,
    };

    // Only add encryption fields if encryption is enabled
    if (encrypted) {
      docData.encrypted = encrypted;
      if (iv) docData.iv = iv;
      if (encryptedDEK) docData.encryptedDEK = encryptedDEK;
      if (encryptedDEKs) docData.encryptedDEKs = encryptedDEKs;
    }

    const docRef = await addDoc(collection(db, DROPS_COLLECTION), docData);

    return {
      id: docRef.id,
      userId,
      type: 'text',
      name,
      content: encrypted ? undefined : content, // Don't return encrypted content
      createdAt: now,
      expiresAt,
      expirationOption,
      workspaceId,
      encrypted,
      iv,
      encryptedDEK,
      encryptedDEKs,
    };
  } catch (error) {
    console.error('Error creating text drop:', error);
    return null;
  }
}

export async function createFileDrop(
  userId: string,
  file: File,
  expirationOption: ExpirationOption = '2h',
  workspaceId: string | null = null,
  workspaceMembers?: string[]
): Promise<{ drop: Drop | null; error?: string }> {
  try {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return {
        drop: null,
        error: `File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}. Your file is ${formatFileSize(file.size)}.`
      };
    }

    const now = new Date();
    const expiresAt = getExpirationDate(expirationOption);

    // Convert file to base64
    const fileData = await fileToBase64(file);

    let encryptedFileData = fileData;
    let encrypted = false;
    let iv: string | undefined;
    let encryptedDEK: string | undefined;
    let encryptedDEKs: { [userId: string]: { encryptedDEK: string; iv: string } } | undefined;

    // Check if user has encryption keys
    const keys = await getUserKeys(userId);
    if (keys) {
      // Generate DEK
      const dek = await generateAESKey();

      // Encrypt file data with DEK
      const encryptedData = await encryptData(fileData, dek);
      encryptedFileData = encryptedData.encrypted;
      iv = encryptedData.iv;
      encrypted = true;

      // Encrypt DEK
      if (workspaceId && workspaceMembers && workspaceMembers.length > 0) {
        // Workspace drop - encrypt DEK for all members
        encryptedDEKs = await encryptDEKForWorkspace(dek, workspaceMembers, keys.privateKey);
      } else {
        // Personal drop - encrypt DEK with user's own key
        const publicKey = await getUserPublicKey(userId);
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek,
            publicKey,
            keys.privateKey
          );
          encryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }
      }
    }

    // Build document data, excluding undefined fields
    const docData: Record<string, unknown> = {
      userId,
      type: 'file',
      name: file.name,
      fileData: encryptedFileData,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      createdAt: serverTimestamp(),
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      expirationOption,
      workspaceId,
    };

    // Only add encryption fields if encryption is enabled
    if (encrypted) {
      docData.encrypted = encrypted;
      if (iv) docData.iv = iv;
      if (encryptedDEK) docData.encryptedDEK = encryptedDEK;
      if (encryptedDEKs) docData.encryptedDEKs = encryptedDEKs;
    }

    // Create document
    const docRef = await addDoc(collection(db, DROPS_COLLECTION), docData);

    return {
      drop: {
        id: docRef.id,
        userId,
        type: 'file',
        name: file.name,
        fileData: encrypted ? undefined : fileData, // Don't return encrypted data
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        createdAt: now,
        expiresAt,
        expirationOption,
        workspaceId,
        encrypted,
        iv,
        encryptedDEK,
        encryptedDEKs,
      }
    };
  } catch (error) {
    console.error('Error creating file drop:', error);
    return { drop: null, error: 'Failed to upload file. Please try again.' };
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}

export async function deleteDrop(drop: Drop): Promise<boolean> {
  try {
    await deleteDoc(doc(db, DROPS_COLLECTION, drop.id));
    return true;
  } catch (error) {
    console.error('Error deleting drop:', error);
    return false;
  }
}

export async function cleanupExpiredDrops(userId: string): Promise<void> {
  const now = new Date();

  // Simple query - just filter by userId, check expiresAt client-side
  const q = query(
    collection(db, DROPS_COLLECTION),
    where('userId', '==', userId),
    limit(100)
  );

  const snapshot = await getDocs(q);
  snapshot.forEach(async (document) => {
    const data = document.data();

    // Skip if no expiresAt (forever drops)
    if (!data.expiresAt) return;

    const expiresAt = data.expiresAt.toDate();

    // Only delete if expired
    if (expiresAt <= now) {
      await deleteDrop({
        id: document.id,
        userId: data.userId,
        type: data.type,
        name: data.name,
        content: data.content,
        fileData: data.fileData,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        createdAt: data.createdAt?.toDate() || new Date(),
        expiresAt: expiresAt,
        expirationOption: data.expirationOption,
        workspaceId: data.workspaceId || null,
      });
    }
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getTimeRemaining(expiresAt: Date | null): string {
  // Forever drops have no expiration
  if (!expiresAt) return 'Forever';

  const now = new Date();
  const diff = expiresAt.getTime() - now.getTime();

  if (diff <= 0) return 'Expired';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Decrypt a drop's content
export async function decryptDrop(drop: Drop, currentUserId: string): Promise<Drop> {
  // If not encrypted, return as-is
  if (!drop.encrypted) {
    return drop;
  }

  // Get user's keys
  const keys = await getUserKeys(currentUserId);
  if (!keys) {
    console.error('User has no encryption keys');
    return drop;
  }

  // Get the encrypted DEK
  let dekIv: string;
  let encryptedDEK: string;

  if (drop.encryptedDEKs && drop.encryptedDEKs[currentUserId]) {
    // Workspace drop - use our encrypted DEK
    encryptedDEK = drop.encryptedDEKs[currentUserId].encryptedDEK;
    dekIv = drop.encryptedDEKs[currentUserId].iv;
  } else if (drop.encryptedDEK) {
    // Personal drop - parse the encrypted DEK
    const parsed = JSON.parse(drop.encryptedDEK);
    encryptedDEK = parsed.encryptedDEK;
    dekIv = parsed.iv;
  } else {
    console.error('No encrypted DEK found for this user');
    return drop;
  }

  // Get the creator's public key to derive shared secret
  const creatorPublicKey = await getUserPublicKey(drop.userId);
  if (!creatorPublicKey) {
    console.error('Could not get creator public key');
    return drop;
  }

  try {
    // Decrypt the DEK
    const dek = await decryptDEKForUser(encryptedDEK, dekIv, creatorPublicKey, keys.privateKey);

    // Decrypt the content
    const dataToDecrypt = drop.type === 'text' ? drop.content : drop.fileData;
    if (!dataToDecrypt || !drop.iv) {
      return drop;
    }

    const decryptedData = await decryptData(dataToDecrypt, dek, drop.iv);

    // Return drop with decrypted content
    return {
      ...drop,
      content: drop.type === 'text' ? decryptedData : drop.content,
      fileData: drop.type === 'file' ? decryptedData : drop.fileData,
    };
  } catch (error) {
    console.error('Failed to decrypt drop:', error);
    return drop;
  }
}