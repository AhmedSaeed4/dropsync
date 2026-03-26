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
  decryptDEKForUser,
  getWorkspaceKey,
  hasWorkspaceKey
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
  // For workspace drops, filter by workspaceId only
  let q;

  if (workspaceId) {
    // Workspace drops - filter by workspaceId
    q = query(
      collection(db, DROPS_COLLECTION),
      where('workspaceId', '==', workspaceId),
      limit(MAX_DROPS)
    );
  } else {
    // Personal drops - filter by BOTH userId AND workspaceId == null
    q = query(
      collection(db, DROPS_COLLECTION),
      where('userId', '==', userId),
      where('workspaceId', '==', null),
      limit(MAX_DROPS)
    );
  }

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
          category: data.category || undefined,
          creatorName: data.creatorName || undefined,
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
  workspaceMembers?: string[],
  category?: string,
  creatorName?: string
): Promise<Drop | null> {
  try {
    const now = new Date();
    const expiresAt = getExpirationDate(expirationOption);

    let encryptedContent = content;
    let encrypted = false;
    let iv: string | undefined;
    let encryptedDEK: string | undefined;

    // For workspace drops, use workspace key (no personal keys needed)
    if (workspaceId) {
      const workspaceKey = await getWorkspaceKey(workspaceId, userId);
      if (workspaceKey) {
        // Encrypt content with workspace key
        const encryptedData = await encryptData(content, workspaceKey);
        encryptedContent = encryptedData.encrypted;
        iv = encryptedData.iv;
        encrypted = true;
      }
    } else {
      // Personal drop - need user's personal keys
      const keys = await getUserKeys(userId);
      if (keys) {
        // Generate DEK
        const dek = await generateAESKey();

        // Encrypt content with DEK
        const encryptedData = await encryptData(content, dek);
        encryptedContent = encryptedData.encrypted;
        iv = encryptedData.iv;
        encrypted = true;

        // Encrypt DEK with user's own key
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
      category: category || null, // Add category field
    };

    // Add creator info for workspace drops
    if (workspaceId && creatorName) {
      docData.creatorName = creatorName;
    }

    // Only add encryption fields if encryption is enabled
    if (encrypted) {
      docData.encrypted = encrypted;
      if (iv) docData.iv = iv;
      if (encryptedDEK) docData.encryptedDEK = encryptedDEK;
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
      category,
      creatorName: workspaceId ? creatorName : undefined,
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
  workspaceMembers?: string[],
  creatorName?: string
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

    // For workspace drops, use workspace key (no personal keys needed)
    if (workspaceId) {
      const workspaceKey = await getWorkspaceKey(workspaceId, userId);
      if (workspaceKey) {
        // Encrypt content with workspace key
        const encryptedData = await encryptData(fileData, workspaceKey);
        encryptedFileData = encryptedData.encrypted;
        iv = encryptedData.iv;
        encrypted = true;
      }
    } else {
      // Personal drop - need user's personal keys
      const keys = await getUserKeys(userId);
      if (keys) {
        // Generate DEK
        const dek = await generateAESKey();

        // Encrypt file data with DEK
        const encryptedData = await encryptData(fileData, dek);
        encryptedFileData = encryptedData.encrypted;
        iv = encryptedData.iv;
        encrypted = true;

        // Encrypt DEK with user's own key
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
    }

    // Add creator name for workspace drops
    if (workspaceId && creatorName) {
      docData.creatorName = creatorName;
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
        creatorName: workspaceId ? creatorName : undefined,
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

  try {
    let dek: CryptoKey;

    // For workspace drops, use workspace key (no personal keys needed)
    if (drop.workspaceId) {
      const workspaceKey = await getWorkspaceKey(drop.workspaceId, currentUserId);
      if (!workspaceKey) {
        console.error('Could not get workspace key');
        return drop;
      }
      dek = workspaceKey;
    } else {
      // Personal drop - need user's personal keys
      const keys = await getUserKeys(currentUserId);
      if (!keys) {
        console.error('User has no encryption keys');
        return drop;
      }

      if (!drop.encryptedDEK) {
        console.error('No encrypted DEK for personal drop');
        return drop;
      }

      const parsed = JSON.parse(drop.encryptedDEK);
      const creatorPublicKey = await getUserPublicKey(drop.userId);
      if (!creatorPublicKey) {
        console.error('Could not get creator public key');
        return drop;
      }

      dek = await decryptDEKForUser(parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey);
    }

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