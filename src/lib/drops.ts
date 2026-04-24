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
import { db, auth } from './firebase';
import { Drop, ExpirationOption } from '@/types';
import { generateAESKey, encryptData, decryptData, importAESKey, exportKey } from './crypto';
import { deleteSharesForDrop } from './shares';
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
const MAX_DROPS = 200;
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit
const MAX_ENCRYPTION_SIZE = 10 * 1024 * 1024; // 10MB - files larger than this won't be encrypted

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
          fileUrl: data.fileUrl, // NEW: R2 URL
          r2Key: data.r2Key,     // NEW: R2 key for deletion
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
          imageUrl: data.imageUrl || undefined,
          imageR2Key: data.imageR2Key || undefined,
          imageSize: data.imageSize || undefined,
          imageMimeType: data.imageMimeType || undefined,
          imageIv: data.imageIv || undefined,
          category: data.category || undefined,
          creatorName: data.creatorName || undefined,
        });
      }
    });

    // Sort by createdAt desc on client side
    drops.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    callback(drops);
  }, (error) => {
    // Handle permission errors gracefully (e.g., workspace deleted)
    if (error.code === 'permission-denied' || error.message?.includes('permissions')) {
      console.log('Drops listener: Access denied, workspace may have been deleted');
      // Return empty array instead of erroring
      callback([]);
      return;
    }
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
  creatorName?: string,
  imageFile?: File
): Promise<Drop | null> {
  try {
    const now = new Date();
    const expiresAt = getExpirationDate(expirationOption);

    let encryptedContent = content;
    let encrypted = false;
    let iv: string | undefined;
    let encryptedDEK: string | undefined;
    let imageUrl: string | undefined;
    let imageR2Key: string | undefined;
    let imageEncryptedData: string | undefined;
    let imageIv: string | undefined;

    // For workspace drops, use workspace key (no personal keys needed)
    if (workspaceId) {
      const workspaceKey = await getWorkspaceKey(workspaceId, userId);
      if (workspaceKey) {
        // Encrypt content with workspace key
        const encryptedData = await encryptData(content, workspaceKey);
        encryptedContent = encryptedData.encrypted;
        iv = encryptedData.iv;
        encrypted = true;

        // Encrypt image if provided
        if (imageFile) {
          const imageBase64 = await fileToBase64(imageFile);
          const encImg = await encryptData(imageBase64, workspaceKey);
          imageEncryptedData = encImg.encrypted;
          imageIv = encImg.iv;
        }
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

        // Encrypt image with same DEK
        if (imageFile) {
          const imageBase64 = await fileToBase64(imageFile);
          const encImg = await encryptData(imageBase64, dek);
          imageEncryptedData = encImg.encrypted;
          imageIv = encImg.iv;
        }
      }
    }

    // Upload image to R2 if present
    if (imageFile && imageEncryptedData) {
      try {
        const uploadResult = await uploadToR2(imageEncryptedData);
        imageUrl = uploadResult.url;
        imageR2Key = uploadResult.key;
      } catch (uploadError) {
        console.error('Image R2 upload failed:', uploadError);
        return null;
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
      category: category || null,
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

    // Add image fields
    if (imageFile) {
      docData.imageUrl = imageUrl;
      docData.imageR2Key = imageR2Key;
      docData.imageSize = imageFile.size;
      docData.imageMimeType = imageFile.type || 'image/png';
      if (imageIv) docData.imageIv = imageIv;
    }

    const docRef = await addDoc(collection(db, DROPS_COLLECTION), docData);

    return {
      id: docRef.id,
      userId,
      type: 'text',
      name,
      content: encrypted ? undefined : content,
      createdAt: now,
      expiresAt,
      expirationOption,
      workspaceId,
      encrypted,
      iv,
      encryptedDEK,
      imageUrl,
      imageR2Key,
      imageSize: imageFile?.size,
      imageMimeType: imageFile?.type || 'image/png',
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
    // Check file size (NOW UP TO 50MB instead of 800KB)
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
    let fileUrl: string | undefined;
    let r2Key: string | undefined;

    // Only encrypt files smaller than MAX_ENCRYPTION_SIZE (10MB)
    const shouldEncrypt = file.size < MAX_ENCRYPTION_SIZE;

    if (shouldEncrypt) {
      // For workspace drops, use workspace key (no personal keys needed)
      if (workspaceId) {
        const workspaceKey = await getWorkspaceKey(workspaceId, userId);
        if (workspaceKey) {
          // Encrypt content with workspace key
          const encryptedData = await encryptData(fileData, workspaceKey);
          encryptedFileData = encryptedData.encrypted;
          iv = encryptedData.iv;
          encrypted = true;

          // Upload encrypted data to R2
          try {
            const uploadResult = await uploadToR2(encryptedFileData);
            fileUrl = uploadResult.url;
            r2Key = uploadResult.key;
          } catch (uploadError) {
            console.error('R2 upload failed:', uploadError);
            return { drop: null, error: 'Failed to upload file to storage. Please try again.' };
          }
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

          // Upload encrypted data to R2
          try {
            const uploadResult = await uploadToR2(encryptedFileData);
            fileUrl = uploadResult.url;
            r2Key = uploadResult.key;
          } catch (uploadError) {
            console.error('R2 upload failed:', uploadError);
            return { drop: null, error: 'Failed to upload file to storage. Please try again.' };
          }
        }
      }
    } else {
      // Large file - upload directly without encryption
      try {
        const uploadResult = await uploadToR2(fileData);
        fileUrl = uploadResult.url;
        r2Key = uploadResult.key;
      } catch (uploadError) {
        console.error('R2 upload failed:', uploadError);
        return { drop: null, error: 'Failed to upload file to storage. Please try again.' };
      }
    }

    // Build document data
    const docData: Record<string, unknown> = {
      userId,
      type: 'file',
      name: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      createdAt: serverTimestamp(),
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      expirationOption,
      workspaceId,
    };

    // Add R2 URL and key (NEW)
    if (fileUrl) {
      docData.fileUrl = fileUrl;
      docData.r2Key = r2Key;
    }

    // Add encryption fields
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
        fileUrl,
        r2Key,
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
    // Delete from R2 if file has R2 key
    if (drop.r2Key) {
      try {
        await deleteFromR2(drop.r2Key, drop.workspaceId);
      } catch (error) {
        console.error('Failed to delete from R2:', error);
      }
    }

    // Delete attached image from R2 if present
    if (drop.imageR2Key) {
      try {
        await deleteFromR2(drop.imageR2Key, drop.workspaceId);
      } catch (error) {
        console.error('Failed to delete image from R2:', error);
      }
    }

    await deleteDoc(doc(db, DROPS_COLLECTION, drop.id));
    // Delete any associated share links
    await deleteSharesForDrop(drop.id);
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
  const deletePromises: Promise<void>[] = [];

  snapshot.forEach((document) => {
    const data = document.data();

    // Skip if no expiresAt (forever drops)
    if (!data.expiresAt) return;

    const expiresAt = data.expiresAt.toDate();

    // Only delete if expired
    if (expiresAt <= now) {
      // Create a promise for each deletion
      const deletePromise = async () => {
        // Delete from R2 first if file has r2Key
        if (data.r2Key) {
          try {
            await deleteFromR2(data.r2Key, data.workspaceId || null);
          } catch (error) {
            console.error('Failed to delete R2 file:', error);
          }
        }

        // Delete attached image from R2 if present
        if (data.imageR2Key) {
          try {
            await deleteFromR2(data.imageR2Key, data.workspaceId || null);
          } catch (error) {
            console.error('Failed to delete image from R2:', error);
          }
        }

        // Then delete Firestore document
        await deleteDoc(doc(db, DROPS_COLLECTION, document.id));
        // Delete associated share links
        await deleteSharesForDrop(document.id);
      };

      deletePromises.push(deletePromise());
    }
  });

  // Process all deletions
  await Promise.allSettled(deletePromises);
}

export function getYouTubeVideoId(text: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
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
  // If not encrypted, still need to fetch R2 files
  if (!drop.encrypted) {
    // For non-encrypted files with R2 URL, fetch the data
    if (drop.type === 'file' && drop.fileUrl && !drop.fileData) {
      try {
        const response = await fetch(drop.fileUrl);
        if (!response.ok) {
          console.error('Failed to fetch file from R2');
          return drop;
        }
        const fileData = await response.text();
        return { ...drop, fileData };
      } catch (error) {
        console.error('Failed to fetch non-encrypted file:', error);
        return drop;
      }
    }
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

    // NEW: For file drops with R2 URL, fetch the encrypted data first
    let dataToDecrypt: string;
    if (drop.type === 'file') {
      if (drop.fileUrl) {
        // NEW: Fetch from R2
        const response = await fetch(drop.fileUrl);
        if (!response.ok) {
          console.error('Failed to fetch encrypted file from R2');
          return drop;
        }
        dataToDecrypt = await response.text();
      } else if (drop.fileData) {
        // OLD: Backward compatibility for existing drops
        dataToDecrypt = drop.fileData;
      } else {
        console.error('No file data or URL available');
        return drop;
      }
    } else {
      // Text drop - content is already in Firestore
      dataToDecrypt = drop.content || '';
    }

    if (!dataToDecrypt || !drop.iv) {
      return drop;
    }

    const decryptedData = await decryptData(dataToDecrypt, dek, drop.iv);

    // Decrypt attached image if present (text drop with image)
    let imageData: string | undefined;
    if (drop.type === 'text' && drop.imageUrl) {
      try {
        const imgResponse = await fetch(drop.imageUrl);
        if (imgResponse.ok) {
          const encryptedImageData = await imgResponse.text();
          const imgIv = drop.imageIv;
          if (encryptedImageData && imgIv) {
            imageData = await decryptData(encryptedImageData, dek, imgIv);
          }
        }
      } catch (imgError) {
        console.error('Failed to decrypt attached image:', imgError);
      }
    }

    // Return drop with decrypted content
    return {
      ...drop,
      content: drop.type === 'text' ? decryptedData : drop.content,
      fileData: drop.type === 'file' ? decryptedData : drop.fileData,
      imageData,
    };
  } catch (error) {
    console.error('Failed to decrypt drop:', error);
    return drop;
  }
}

// =============================================
// Helper function to upload to R2
// Uses Firebase ID token for authentication
// =============================================
async function uploadToR2(fileData: string): Promise<{ url: string; key: string }> {
  // Get Firebase ID token from current user
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated');
  }

  const idToken = await currentUser.getIdToken();

  // Step 1: Get presigned URL from our API
  const presignResponse = await fetch('/api/presign', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
    },
  });

  if (!presignResponse.ok) {
    const error = await presignResponse.json();
    throw new Error(error.error || 'Failed to get upload URL');
  }

  const { presignedUrl, key, fileUrl } = await presignResponse.json();

  // Step 2: Upload directly to R2 using presigned URL
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: fileData,
  });

  if (!uploadResponse.ok) {
    throw new Error(`R2 upload failed: ${uploadResponse.status}`);
  }

  return { url: fileUrl, key };
}

// =============================================
// Helper function to delete from R2
// Uses Firebase ID token for authentication
// =============================================
export async function deleteFromR2(
  key: string,
  workspaceId: string | null
): Promise<void> {
  // Get Firebase ID token from current user
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated');
  }

  const idToken = await currentUser.getIdToken();

  const response = await fetch('/api/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ key, workspaceId }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `R2 delete failed: ${response.status}`);
  }
}