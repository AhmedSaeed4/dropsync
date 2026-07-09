import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  getDoc,
  getDocs,
  updateDoc
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { Drop, ExpirationOption } from '@/types';
import { generateAESKey, encryptData, decryptData, importAESKey, exportKey } from './crypto';
import { deleteSharesForDrop, syncSharesExpiryForDrop } from './shares';
import {
  getUserKeys,
  getUserPublicKey,
  encryptDEKForWorkspace,
  encryptDEKForUser,
  decryptDEKForUser,
  getWorkspaceKey,
  hasWorkspaceKey
} from './keys';
import { ensureCategoriesForTarget, type CategoryNameMap } from './categories';

const DROPS_COLLECTION = 'drops';
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
      where('workspaceId', '==', workspaceId)
    );
  } else {
    // Personal drops - filter by BOTH userId AND workspaceId == null
    q = query(
      collection(db, DROPS_COLLECTION),
      where('userId', '==', userId),
      where('workspaceId', '==', null)
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
          categories: data.categories || (data.category ? [data.category] : []),
          creatorName: data.creatorName || undefined,
          pinned: data.pinned || false,
          isDrawing: data.isDrawing || false,
          locked: data.locked || false,
          fileFormat: data.fileFormat,
        });
      }
    });

    // Sort: pinned first, then by createdAt desc
    drops.sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
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
  imageFile?: File,
  categories?: string[],
  isDrawing?: boolean,
  locked: boolean = false
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

        // Encrypt DEK with user's own key. Use keys.publicKey (already in hand from getUserKeys
        // above) instead of a redundant getUserPublicKey(self) read of userPublicKeys — that
        // separate read can return null during the ~1-2s login window before
        // ensurePublicKeyPublished publishes the doc, silently saving the drop encrypted with no
        // DEK (permanently undecryptable). keys.publicKey is always present when keys is non-null.
        const publicKey = keys.publicKey;
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
      locked,
      category: null,
      categories: categories && categories.length > 0 ? categories : (category ? [category] : []),
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

    // Mark as drawing if applicable
    if (isDrawing) {
      docData.isDrawing = true;
    }

    let docRef: Awaited<ReturnType<typeof addDoc>>;
    try {
      docRef = await addDoc(collection(db, DROPS_COLLECTION), docData);
    } catch (writeError) {
      // Record write failed after the image uploaded → delete the orphaned R2 object so storage
      // isn't left holding a file with no drop. Best-effort; never mask the original write error.
      if (imageR2Key) {
        try {
          await deleteFromR2(imageR2Key, workspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned image after write failure:', cleanupError);
        }
      }
      throw writeError;
    }

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
      isDrawing: isDrawing || false,
      locked,
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
  creatorName?: string,
  locked: boolean = false
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

    let encrypted = false;
    let iv: string | undefined;
    let encryptedDEK: string | undefined;
    let fileUrl: string | undefined;
    let r2Key: string | undefined;
    let fileFormat: 'binary' | undefined;

    // Only encrypt files smaller than MAX_ENCRYPTION_SIZE (10MB)
    const shouldEncrypt = file.size < MAX_ENCRYPTION_SIZE;

    if (shouldEncrypt) {
      // Convert file to base64 — ONLY needed for the ENCRYPTED path (encryption operates on the
      // base64 string). The unencrypted large-file branch below uploads the raw File as binary,
      // so fileToBase64 is intentionally skipped there.
      const fileData = await fileToBase64(file);
      let encryptedFileData = fileData;

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

          // Encrypt DEK with user's own key. Use keys.publicKey (already in hand from getUserKeys
          // above) instead of a redundant getUserPublicKey(self) read of userPublicKeys — that
          // separate read can return null during the ~1-2s login window before
          // ensurePublicKeyPublished publishes the doc, silently saving the drop encrypted with no
          // DEK (permanently undecryptable). keys.publicKey is always present when keys is non-null.
          const publicKey = keys.publicKey;
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
      // Large unencrypted file — upload as REAL BINARY so the browser can stream it (no base64
      // inflate, ~33% smaller) and flag it so players stream the URL directly instead of fetching
      // + decoding text. Applies to any unencrypted large file (mostly videos); large non-video
      // files become binary too — harmless: /api/share/download already sniffs bytes, and this
      // never touches drop.fileData population, so preview/download behavior is unchanged.
      try {
        const uploadResult = await uploadBinaryFileToR2(file);
        fileUrl = uploadResult.url;
        r2Key = uploadResult.key;
        fileFormat = 'binary';
      } catch (uploadError) {
        console.error('R2 binary upload failed:', uploadError);
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
      locked,
    };

    // Add R2 URL and key (NEW)
    if (fileUrl) {
      docData.fileUrl = fileUrl;
      docData.r2Key = r2Key;
    }

    // Add the storage-format flag so players know to stream the URL directly (binary).
    if (fileFormat) {
      docData.fileFormat = fileFormat;
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
    let docRef: Awaited<ReturnType<typeof addDoc>>;
    try {
      docRef = await addDoc(collection(db, DROPS_COLLECTION), docData);
    } catch (writeError) {
      // Record write failed after the file uploaded → delete the orphaned R2 object so storage
      // isn't left holding a file with no drop. Best-effort; never mask the original write error.
      if (r2Key) {
        try {
          await deleteFromR2(r2Key, workspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned file after write failure:', cleanupError);
        }
      }
      throw writeError;
    }

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
        fileFormat,
        creatorName: workspaceId ? creatorName : undefined,
        locked,
      }
    };
  } catch (error) {
    console.error('Error creating file drop:', error);
    return { drop: null, error: 'Failed to upload file. Please try again.' };
  }
}

export async function updateDropMetadata(
  dropId: string,
  updates: {
    name?: string;
    category?: string | null;
    categories?: string[];
    expirationOption?: ExpirationOption;
    locked?: boolean;
  }
): Promise<boolean> {
  try {
    const docRef = doc(db, DROPS_COLLECTION, dropId);
    const updateData: Record<string, unknown> = {};

    if (updates.name !== undefined) {
      updateData.name = updates.name;
    }
    if (updates.categories !== undefined) {
      updateData.categories = updates.categories;
      updateData.category = null;
    } else if (updates.category !== undefined) {
      updateData.category = updates.category || null;
    }
    // Lock state — write only when the caller explicitly passes it (never default/synthesize).
    if (updates.locked !== undefined) {
      updateData.locked = updates.locked;
    }
    // Hoisted so it stays in scope for the best-effort share-expiry sync below. getExpirationDate
    // only runs when the expiry is actually changing, so this is behavior-identical to before.
    const expiresAt =
      updates.expirationOption !== undefined ? getExpirationDate(updates.expirationOption) : undefined;
    if (updates.expirationOption !== undefined) {
      updateData.expirationOption = updates.expirationOption;
      updateData.expiresAt = expiresAt ? Timestamp.fromDate(expiresAt) : null;
    }

    await updateDoc(docRef, updateData);

    // Keep every share link for this drop in sync with the drop's new expiry (shorter, longer,
    // or forever). Best-effort: the helper never throws, so a failed sync can't change this
    // function's return value or fail the edit above.
    if (expiresAt !== undefined) {
      await syncSharesExpiryForDrop(dropId, expiresAt);
    }
    return true;
  } catch (error) {
    console.error('Error updating drop metadata:', error);
    return false;
  }
}

export async function updateTextDrop(
  drop: Drop,
  updates: {
    name?: string;
    content?: string;
    category?: string | null;
    categories?: string[];
    expirationOption?: ExpirationOption;
    imageFile?: File | null;
    imageRemoved?: boolean;
    locked?: boolean;
  },
  currentUserId: string
): Promise<boolean> {
  try {
    const docRef = doc(db, DROPS_COLLECTION, drop.id);
    const updateData: Record<string, unknown> = {};
    const r2KeysToDelete: { key: string; workspaceId: string | null }[] = [];

    // Simple metadata updates
    if (updates.name !== undefined) {
      updateData.name = updates.name;
    }
    if (updates.categories !== undefined) {
      updateData.categories = updates.categories;
      updateData.category = null;
    } else if (updates.category !== undefined) {
      updateData.category = updates.category || null;
    }
    // Lock state — write only when the caller explicitly passes it (never default/synthesize).
    if (updates.locked !== undefined) {
      updateData.locked = updates.locked;
    }
    // Hoisted so it stays in scope for the best-effort share-expiry sync after updateDoc.
    // getExpirationDate only runs when the expiry is actually changing.
    const expiresAt =
      updates.expirationOption !== undefined ? getExpirationDate(updates.expirationOption) : undefined;
    if (updates.expirationOption !== undefined) {
      updateData.expirationOption = updates.expirationOption;
      updateData.expiresAt = expiresAt ? Timestamp.fromDate(expiresAt) : null;
    }

    const contentChanged = updates.content !== undefined;
    const imageChanged = !!updates.imageFile;
    const imageRemoved = !!updates.imageRemoved && !updates.imageFile;

    // PATH 1: Content changed → new DEK → re-encrypt content + handle image with same DEK
    if (contentChanged) {
      if (drop.workspaceId) {
        const workspaceKey = await getWorkspaceKey(drop.workspaceId, currentUserId);
        if (!workspaceKey) {
          console.error('Could not get workspace key for re-encryption');
          return false;
        }

        const encContent = await encryptData(updates.content!, workspaceKey);
        updateData.content = encContent.encrypted;
        updateData.iv = encContent.iv;
        updateData.encrypted = true;

        if (imageChanged && updates.imageFile) {
          if (drop.imageR2Key) {
            r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: drop.workspaceId });
          }
          const imageBase64 = await fileToBase64(updates.imageFile);
          const encImg = await encryptData(imageBase64, workspaceKey);
          const uploadResult = await uploadToR2(encImg.encrypted);
          updateData.imageUrl = uploadResult.url;
          updateData.imageR2Key = uploadResult.key;
          updateData.imageSize = updates.imageFile.size;
          updateData.imageMimeType = updates.imageFile.type || 'image/png';
          updateData.imageIv = encImg.iv;
        } else if (imageRemoved) {
          if (drop.imageR2Key) {
            r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: drop.workspaceId });
          }
          updateData.imageUrl = null;
          updateData.imageR2Key = null;
          updateData.imageSize = null;
          updateData.imageMimeType = null;
          updateData.imageIv = null;
        }
        // Workspace key is stable — unchanged images stay decryptable, no re-encryption needed
      } else {
        // Personal drop → new DEK generated
        const keys = await getUserKeys(currentUserId);
        if (!keys) {
          console.error('User has no encryption keys for re-encryption');
          return false;
        }

        const dek = await generateAESKey();

        const encContent = await encryptData(updates.content!, dek);
        updateData.content = encContent.encrypted;
        updateData.iv = encContent.iv;
        updateData.encrypted = true;

        // Use keys.publicKey (already in hand) — a separate getUserPublicKey(self) read can return
        // null during the login publish window, which here would brick an existing drop.
        const publicKey = keys.publicKey;
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek, publicKey, keys.privateKey
          );
          updateData.encryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }

        if (imageChanged && updates.imageFile) {
          if (drop.imageR2Key) {
            r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: null });
          }
          const imageBase64 = await fileToBase64(updates.imageFile);
          const encImg = await encryptData(imageBase64, dek);
          const uploadResult = await uploadToR2(encImg.encrypted);
          updateData.imageUrl = uploadResult.url;
          updateData.imageR2Key = uploadResult.key;
          updateData.imageSize = updates.imageFile.size;
          updateData.imageMimeType = updates.imageFile.type || 'image/png';
          updateData.imageIv = encImg.iv;
        } else if (imageRemoved) {
          if (drop.imageR2Key) {
            r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: null });
          }
          updateData.imageUrl = null;
          updateData.imageR2Key = null;
          updateData.imageSize = null;
          updateData.imageMimeType = null;
          updateData.imageIv = null;
        } else if (drop.imageR2Key && drop.imageUrl) {
          // DEK changed but image unchanged → must re-encrypt image with new DEK
          try {
            const imgResponse = await fetch(drop.imageUrl);
            if (imgResponse.ok) {
              const encryptedImageData = await imgResponse.text();
              const oldParsed = JSON.parse(drop.encryptedDEK!);
              const creatorPublicKey = await getUserPublicKey(drop.userId);
              if (creatorPublicKey) {
                const oldDek = await decryptDEKForUser(
                  oldParsed.encryptedDEK, oldParsed.iv, creatorPublicKey, keys.privateKey
                );
                const decryptedImage = await decryptData(encryptedImageData, oldDek, drop.imageIv!);
                const encImg = await encryptData(decryptedImage, dek);
                r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: null });
                const uploadResult = await uploadToR2(encImg.encrypted);
                updateData.imageUrl = uploadResult.url;
                updateData.imageR2Key = uploadResult.key;
                updateData.imageIv = encImg.iv;
              }
            }
          } catch (imgError) {
            console.error('Failed to re-encrypt image with new DEK:', imgError);
          }
        }
      }
    } else if (imageChanged || imageRemoved) {
      // PATH 2: Image changed/removed but content unchanged → use existing DEK
      if (imageRemoved) {
        if (drop.imageR2Key) {
          r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: drop.workspaceId });
        }
        updateData.imageUrl = null;
        updateData.imageR2Key = null;
        updateData.imageSize = null;
        updateData.imageMimeType = null;
        updateData.imageIv = null;
      } else if (updates.imageFile) {
        let encryptionKey: CryptoKey;
        if (drop.workspaceId) {
          const workspaceKey = await getWorkspaceKey(drop.workspaceId, currentUserId);
          if (!workspaceKey) {
            console.error('Could not get workspace key');
            return false;
          }
          encryptionKey = workspaceKey;
        } else {
          const keys = await getUserKeys(currentUserId);
          if (!keys) {
            console.error('User has no encryption keys');
            return false;
          }
          const parsed = JSON.parse(drop.encryptedDEK!);
          const creatorPublicKey = await getUserPublicKey(drop.userId);
          if (!creatorPublicKey) {
            console.error('Could not get creator public key');
            return false;
          }
          encryptionKey = await decryptDEKForUser(
            parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey
          );
        }

        if (drop.imageR2Key) {
          r2KeysToDelete.push({ key: drop.imageR2Key, workspaceId: drop.workspaceId });
        }
        const imageBase64 = await fileToBase64(updates.imageFile);
        const encImg = await encryptData(imageBase64, encryptionKey);
        const uploadResult = await uploadToR2(encImg.encrypted);
        updateData.imageUrl = uploadResult.url;
        updateData.imageR2Key = uploadResult.key;
        updateData.imageSize = updates.imageFile.size;
        updateData.imageMimeType = updates.imageFile.type || 'image/png';
        updateData.imageIv = encImg.iv;
      }
    }
    // PATH 3: Only metadata changed (name, category, expiration) → no re-encryption

    // Write to Firestore FIRST — if this fails, old R2 objects are untouched
    try {
      await updateDoc(docRef, updateData);
    } catch (writeError) {
      // Write failed after a new image uploaded → delete ONLY the new image object (never the
      // previous version's image, which is still referenced by the existing doc). Best-effort;
      // never mask the original write error.
      const newImageKey = updateData.imageR2Key;
      if (typeof newImageKey === 'string' && newImageKey) {
        try {
          await deleteFromR2(newImageKey, drop.workspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned image after write failure:', cleanupError);
        }
      }
      throw writeError;
    }

    // Only clean up old R2 objects after Firestore succeeds
    for (const { key, workspaceId } of r2KeysToDelete) {
      try { await deleteFromR2(key, workspaceId); } catch {}
    }

    // Keep every share link for this drop in sync with the drop's new expiry. Best-effort: the
    // helper never throws, so this can't change the return value or fail the edit above.
    if (expiresAt !== undefined) {
      await syncSharesExpiryForDrop(drop.id, expiresAt);
    }

    return true;
  } catch (error) {
    console.error('Error updating text drop:', error);
    return false;
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

export async function pinDrop(dropId: string): Promise<boolean> {
  try {
    const docRef = doc(db, DROPS_COLLECTION, dropId);
    await updateDoc(docRef, { pinned: true });
    return true;
  } catch (error) {
    console.error('Error pinning drop:', error);
    return false;
  }
}

export async function unpinDrop(dropId: string): Promise<boolean> {
  try {
    const docRef = doc(db, DROPS_COLLECTION, dropId);
    await updateDoc(docRef, { pinned: false });
    return true;
  } catch (error) {
    console.error('Error unpinning drop:', error);
    return false;
  }
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

    // Delete associated share links FIRST — while the drop doc still exists, so the
    // server-side ownership check in DELETE /api/share can resolve the drop.
    await deleteSharesForDrop(drop.id);
    await deleteDoc(doc(db, DROPS_COLLECTION, drop.id));
    return true;
  } catch (error) {
    console.error('Error deleting drop:', error);
    return false;
  }
}

export async function cleanupExpiredDrops(
  { userId, workspaceId }: { userId: string; workspaceId?: string | null }
): Promise<void> {
  const now = new Date();

  // Read the ENTIRE scope once (no limit). createDropListener reads this same
  // scope without a limit, so this is one extra one-shot read on workspace open —
  // fine at real scale (workspaces hold hundreds of docs, not millions; large file
  // payloads live in R2, not inline).
  //
  // NOTE: an earlier design used a limit(200) batched loop that terminated when a
  // batch held no expired drops. That terminates EARLY for any scope with >200 total
  // docs whose expired drops sit beyond the first 200 (by doc-id order) — which
  // includes the tester's 296-drop workspace this PR exists to fix. A full-scope
  // read is correct; the batched loop is not.
  const q = workspaceId
    ? query(collection(db, DROPS_COLLECTION), where('workspaceId', '==', workspaceId))
    : query(
        collection(db, DROPS_COLLECTION),
        where('userId', '==', userId),
        where('workspaceId', '==', null) // personal scope only (fixes prior imprecision)
      );

  const snapshot = await getDocs(q);

  // SACROSANCT GUARD: permanent ("forever") drops must NEVER be deleted.
  // Also skip corrupt/legacy docs whose expiresAt isn't a real Firestore Timestamp.
  const expired = snapshot.docs.filter((document) => {
    const data = document.data();
    if (!data.expiresAt || !(data.expiresAt instanceof Timestamp)) return false;
    return data.expiresAt.toDate() <= now;
  });

  if (expired.length === 0) return;

  // Per-drop: R2 file → R2 image → share links → Firestore doc.
  // allSettled so one failure can't abort the rest of the batch.
  await Promise.allSettled(
    expired.map(async (document) => {
      const data = document.data();

      // Delete file from R2 first if present
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

      // Delete associated share links FIRST — while the drop doc still exists (see deleteDrop).
      await deleteSharesForDrop(document.id);
      // Then delete the Firestore document
      await deleteDoc(doc(db, DROPS_COLLECTION, document.id));
    })
  );
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

// =============================================
// Move a drop between workspaces (or to/from personal)
// Decrypts with source key, re-encrypts with target key,
// then does a single atomic updateDoc call.
// =============================================
export async function moveDrop(
  drop: Drop,
  targetWorkspaceId: string | null,
  currentUserId: string,
  resolvedCategories?: CategoryNameMap
): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Decrypt the drop to get plaintext
    const decrypted = await decryptDrop(drop, currentUserId);
    if (drop.encrypted && !decrypted.content && drop.type === 'text' && !drop.isDrawing) {
      return { success: false, error: 'Failed to decrypt drop content' };
    }
    if (drop.encrypted && !decrypted.fileData && drop.type === 'file') {
      return { success: false, error: 'Failed to decrypt file content' };
    }

    // Step 2: Re-encrypt with the target key
    let newContent: string | undefined;
    let newFileData: string | undefined;
    let newR2Key: string | undefined;
    let newFileUrl: string | undefined;
    let newIv: string | undefined;
    let newEncryptedDEK: string | undefined;
    let newEncrypted = false;

    const isTargetWorkspace = targetWorkspaceId !== null;

    if (drop.type === 'text') {
      const plaintext = decrypted.content ?? '';
      if (isTargetWorkspace) {
        // Encrypt with workspace key
        const workspaceKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
        if (!workspaceKey) {
          return { success: false, error: 'Could not get target workspace key' };
        }
        const enc = await encryptData(plaintext, workspaceKey);
        newContent = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;
      } else {
        // Encrypt with personal key (new DEK)
        const keys = await getUserKeys(currentUserId);
        if (!keys) {
          return { success: false, error: 'User has no encryption keys' };
        }
        const dek = await generateAESKey();
        const enc = await encryptData(plaintext, dek);
        newContent = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        // Use keys.publicKey (already in hand) — a separate getUserPublicKey(self) read can return
        // null during the login publish window, which here would brick an existing drop.
        const publicKey = keys.publicKey;
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek, publicKey, keys.privateKey
          );
          newEncryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }
      }
    } else if (drop.type === 'file') {
      // For file drops, decrypt the file data (already done in decryptDrop)
      const plaintext = decrypted.fileData ?? '';

      // Check if original was encrypted (file drops >10MB skip encryption)
      const wasEncrypted = drop.encrypted && !!drop.r2Key;

      if (!wasEncrypted) {
        // Large file — skip re-encryption, just update metadata
        // File stays in R2 as-is
        newR2Key = drop.r2Key;
        newFileUrl = drop.fileUrl;
      } else if (isTargetWorkspace) {
        const workspaceKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
        if (!workspaceKey) {
          return { success: false, error: 'Could not get target workspace key' };
        }
        const enc = await encryptData(plaintext, workspaceKey);
        newFileData = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        // Upload re-encrypted file to R2
        const uploadResult = await uploadToR2(newFileData);
        newFileUrl = uploadResult.url;
        newR2Key = uploadResult.key;
      } else {
        const keys = await getUserKeys(currentUserId);
        if (!keys) {
          return { success: false, error: 'User has no encryption keys' };
        }
        const dek = await generateAESKey();
        const enc = await encryptData(plaintext, dek);
        newFileData = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        // Use keys.publicKey (already in hand) — a separate getUserPublicKey(self) read can return
        // null during the login publish window, which here would brick an existing drop.
        const publicKey = keys.publicKey;
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek, publicKey, keys.privateKey
          );
          newEncryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }

        // Upload re-encrypted file to R2
        const uploadResult = await uploadToR2(newFileData);
        newFileUrl = uploadResult.url;
        newR2Key = uploadResult.key;
      }
    }

    // Step 3: Handle attached image (text drops with image)
    let newImageUrl: string | undefined;
    let newImageR2Key: string | undefined;
    let newImageIv: string | undefined;
    let newImageSize: number | undefined;
    let newImageMimeType: string | undefined;
    const oldImageR2Key: string | null = drop.imageR2Key || null;

    if (drop.type === 'text' && drop.imageUrl && drop.imageIv) {
      // Fetch encrypted image from R2
      const imgResponse = await fetch(drop.imageUrl);
      if (imgResponse.ok) {
        const encryptedImageData = await imgResponse.text();

        // Decrypt image with OLD key (from decryptDrop we already have the dek)
        let oldDek: CryptoKey | null = null;
        if (drop.workspaceId) {
          oldDek = await getWorkspaceKey(drop.workspaceId, currentUserId);
        } else {
          const keys = await getUserKeys(currentUserId);
          if (keys && drop.encryptedDEK) {
            const parsed = JSON.parse(drop.encryptedDEK);
            const creatorPublicKey = await getUserPublicKey(drop.userId);
            if (creatorPublicKey) {
              oldDek = await decryptDEKForUser(
                parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey
              );
            }
          }
        }

        if (oldDek) {
          const decryptedImage = await decryptData(encryptedImageData, oldDek, drop.imageIv);

          // Re-encrypt with target key
          let encryptionKey: CryptoKey | null = null;
          if (isTargetWorkspace) {
            encryptionKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
          } else {
            // Use same DEK as text content
            const keys = await getUserKeys(currentUserId);
            if (keys && newEncryptedDEK) {
              const parsed = JSON.parse(newEncryptedDEK);
              const creatorPublicKey = await getUserPublicKey(currentUserId);
              if (creatorPublicKey) {
                encryptionKey = await decryptDEKForUser(
                  parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey
                );
              }
            }
          }

          if (encryptionKey) {
            const encImg = await encryptData(decryptedImage, encryptionKey);
            const uploadResult = await uploadToR2(encImg.encrypted);
            newImageUrl = uploadResult.url;
            newImageR2Key = uploadResult.key;
            newImageIv = encImg.iv;
            newImageSize = drop.imageSize;
            newImageMimeType = drop.imageMimeType;
          }
        }
      }
    }

    // Step 4: Build update data
    const docRef = doc(db, DROPS_COLLECTION, drop.id);
    const updateData: Record<string, unknown> = {
      workspaceId: targetWorkspaceId,
      pinned: false, // Unpin on move
    };

    // When moving to personal, the mover takes ownership
    if (targetWorkspaceId === null) {
      updateData.userId = currentUserId;
    }

    if (newContent !== undefined) {
      updateData.content = newContent;
    }
    if (newIv !== undefined) {
      updateData.iv = newIv;
    }
    if (newEncrypted) {
      updateData.encrypted = true;
      if (newEncryptedDEK) {
        updateData.encryptedDEK = newEncryptedDEK;
      } else if (isTargetWorkspace) {
        // Only null out encryptedDEK for workspace targets (they don't use DEK)
        updateData.encryptedDEK = null;
      } else {
        // Personal target but no encryptedDEK — fatal error, don't write broken drop
        return { success: false, error: 'Failed to encrypt drop for personal space. Please try again.' };
      }
    } else {
      // Ensure encrypted flag matches reality — if we didn't re-encrypt,
      // the drop is not encrypted in the new context
      updateData.encrypted = false;
    }

    // File drop updates
    if (newR2Key !== undefined) {
      updateData.r2Key = newR2Key;
      updateData.fileUrl = newFileUrl;
      // Don't change encrypted flag for large unencrypted files
    }
    if (newFileData !== undefined) {
      updateData.r2Key = newR2Key;
      updateData.fileUrl = newFileUrl;
    }

    // Image updates
    if (newImageUrl !== undefined) {
      updateData.imageUrl = newImageUrl;
      updateData.imageR2Key = newImageR2Key;
      updateData.imageIv = newImageIv;
      updateData.imageSize = newImageSize;
      updateData.imageMimeType = newImageMimeType;
    } else if (oldImageR2Key) {
      // Image was not re-encrypted (e.g., decryption failed) — clear it
      updateData.imageUrl = null;
      updateData.imageR2Key = null;
      updateData.imageIv = null;
      updateData.imageSize = null;
      updateData.imageMimeType = null;
    }

    // creatorName: set when moving to workspace, delete when moving to personal
    if (isTargetWorkspace) {
      const userDisplayName = (await getUserDisplayName(currentUserId));
      updateData.creatorName = userDisplayName || undefined;
    } else {
      updateData.creatorName = null;
    }

    // Category matching: resolve the source categories into the target space. When the caller
    // pre-resolved the whole batch (bulk move), reuse that map to avoid a race where N concurrent
    // moves each query-before-write and all create the same category doc. Single-drop callers pass
    // no map → resolve here (one query + create-missing, no race).
    const sourceCategories = drop.categories || (drop.category ? [drop.category] : []);
    let resolvedNames: string[];
    if (sourceCategories.length > 0) {
      const catMap = resolvedCategories ?? await ensureCategoriesForTarget(targetWorkspaceId, currentUserId, sourceCategories);
      resolvedNames = sourceCategories
        .map(c => catMap.get(c.toLowerCase().trim()))
        .filter((n): n is string => !!n);
    } else {
      resolvedNames = [];
    }
    updateData.categories = resolvedNames;
    updateData.category = null;

    // Step 5: Single atomic update
    try {
      await updateDoc(docRef, updateData);
    } catch (writeError) {
      // Update failed after re-uploading the file/image to NEW keys → delete ONLY those new objects
      // (never the drop's existing file/image, which still belong to the unchanged doc). Skip a
      // reused file key — large unencrypted files reuse drop.r2Key, so there is no new object.
      // Best-effort; never mask the original write error.
      if (newR2Key && newR2Key !== drop.r2Key) {
        try {
          await deleteFromR2(newR2Key, targetWorkspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned file after move write failure:', cleanupError);
        }
      }
      if (newImageR2Key) {
        try {
          await deleteFromR2(newImageR2Key, targetWorkspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned image after move write failure:', cleanupError);
        }
      }
      throw writeError;
    }

    // Step 6: Clean up old R2 objects after Firestore succeeds
    if (oldImageR2Key) {
      try { await deleteFromR2(oldImageR2Key, drop.workspaceId); } catch {}
    }
    // Delete old file R2 key if we uploaded a new one
    if (drop.type === 'file' && drop.r2Key && newR2Key && drop.r2Key !== newR2Key) {
      try { await deleteFromR2(drop.r2Key, drop.workspaceId); } catch {}
    }

    return { success: true };
  } catch (error) {
    console.error('Error moving drop:', error);
    return { success: false, error: 'Failed to move drop. Please try again.' };
  }
}

// Copy a drop into another space as a brand-new, fully-independent duplicate. Mirrors
// moveDrop's decrypt → re-encrypt-for-target flow, with four deliberate differences:
//   1. Creates a NEW doc via addDoc (the original doc is never mutated).
//   2. Large unencrypted files (>10MB) are re-uploaded to a NEW R2 key. moveDrop reuses
//      drop.r2Key there, which is safe only because the doc moves in place — two docs must
//      never share one R2 object or deleting one corrupts the other.
//   3. Fresh createdAt + expiresAt computed from the original's expirationOption; the copy
//      is owned by the copier (userId) and starts unpinned.
//   4. Never deletes any R2 object — the original owns its objects and keeps them.
export async function copyDrop(
  drop: Drop,
  targetWorkspaceId: string | null,
  currentUserId: string,
  resolvedCategories?: CategoryNameMap
): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Decrypt the drop to get plaintext.
    const decrypted = await decryptDrop(drop, currentUserId);
    if (drop.encrypted && !decrypted.content && drop.type === 'text' && !drop.isDrawing) {
      return { success: false, error: 'Failed to decrypt drop content' };
    }
    // A file copy always needs the bytes (it cannot reuse the original's R2 key), so a failed
    // fetch/decrypt is fatal — never write a half-broken copy. Binary files carry no fileData
    // (decryptDrop returns them as-is) but fetch their own bytes in the binary branch below.
    if (drop.type === 'file' && !decrypted.fileData && drop.fileFormat !== 'binary') {
      return { success: false, error: 'Failed to read file content for copy' };
    }

    // Step 2: Re-encrypt with the target key (identical to moveDrop), except the large
    // unencrypted-file branch re-uploads to a new R2 key instead of reusing drop.r2Key.
    let newContent: string | undefined;
    let newFileData: string | undefined;
    let newR2Key: string | undefined;
    let newFileUrl: string | undefined;
    let newFileFormat: 'binary' | undefined;
    let newIv: string | undefined;
    let newEncryptedDEK: string | undefined;
    let newEncrypted = false;

    const isTargetWorkspace = targetWorkspaceId !== null;

    if (drop.type === 'text') {
      const plaintext = decrypted.content ?? '';
      if (isTargetWorkspace) {
        const workspaceKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
        if (!workspaceKey) {
          return { success: false, error: 'Could not get target workspace key' };
        }
        const enc = await encryptData(plaintext, workspaceKey);
        newContent = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;
      } else {
        const keys = await getUserKeys(currentUserId);
        if (!keys) {
          return { success: false, error: 'User has no encryption keys' };
        }
        const dek = await generateAESKey();
        const enc = await encryptData(plaintext, dek);
        newContent = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        // Use keys.publicKey (already in hand) — a separate getUserPublicKey(self) read can return
        // null during the login publish window, which here would brick an existing drop.
        const publicKey = keys.publicKey;
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek, publicKey, keys.privateKey
          );
          newEncryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }
      }
    } else if (drop.type === 'file') {
      const plaintext = decrypted.fileData ?? '';
      const wasEncrypted = drop.encrypted && !!drop.r2Key;

      if (!wasEncrypted) {
        if (drop.fileFormat === 'binary' && drop.fileUrl) {
          // Binary file — fetch as a Blob and re-upload to a NEW R2 key (a copy must own its own
          // object; never reuse drop.r2Key). Marked binary so the copy streams too.
          const res = await fetch(drop.fileUrl);
          if (!res.ok) {
            return { success: false, error: 'Failed to read file content for copy' };
          }
          const blob = await res.blob();
          const uploadResult = await uploadBinaryFileToR2(blob);
          newFileUrl = uploadResult.url;
          newR2Key = uploadResult.key;
          newFileFormat = 'binary';
        } else {
          // Legacy data-URI text copy — give the copy its own R2 object (NEVER reuse drop.r2Key).
          const uploadResult = await uploadToR2(plaintext);
          newFileUrl = uploadResult.url;
          newR2Key = uploadResult.key;
          // stays unencrypted (newEncrypted remains false)
        }
      } else if (isTargetWorkspace) {
        const workspaceKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
        if (!workspaceKey) {
          return { success: false, error: 'Could not get target workspace key' };
        }
        const enc = await encryptData(plaintext, workspaceKey);
        newFileData = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        const uploadResult = await uploadToR2(newFileData);
        newFileUrl = uploadResult.url;
        newR2Key = uploadResult.key;
      } else {
        const keys = await getUserKeys(currentUserId);
        if (!keys) {
          return { success: false, error: 'User has no encryption keys' };
        }
        const dek = await generateAESKey();
        const enc = await encryptData(plaintext, dek);
        newFileData = enc.encrypted;
        newIv = enc.iv;
        newEncrypted = true;

        // Use keys.publicKey (already in hand) — a separate getUserPublicKey(self) read can return
        // null during the login publish window, which here would brick an existing drop.
        const publicKey = keys.publicKey;
        if (publicKey) {
          const { encryptedDEK: encDEK, iv: dekIv } = await encryptDEKForUser(
            dek, publicKey, keys.privateKey
          );
          newEncryptedDEK = JSON.stringify({ encryptedDEK: encDEK, iv: dekIv });
        }

        const uploadResult = await uploadToR2(newFileData);
        newFileUrl = uploadResult.url;
        newR2Key = uploadResult.key;
      }
    }

    // Step 3: Handle an attached image (text drops with image) — identical to moveDrop:
    // decrypt with the old key, re-encrypt with the target key, upload to a NEW R2 object.
    let newImageUrl: string | undefined;
    let newImageR2Key: string | undefined;
    let newImageIv: string | undefined;
    let newImageSize: number | undefined;
    let newImageMimeType: string | undefined;
    const oldImageR2Key: string | null = drop.imageR2Key || null;

    if (drop.type === 'text' && drop.imageUrl && drop.imageIv) {
      const imgResponse = await fetch(drop.imageUrl);
      if (imgResponse.ok) {
        const encryptedImageData = await imgResponse.text();

        let oldDek: CryptoKey | null = null;
        if (drop.workspaceId) {
          oldDek = await getWorkspaceKey(drop.workspaceId, currentUserId);
        } else {
          const keys = await getUserKeys(currentUserId);
          if (keys && drop.encryptedDEK) {
            const parsed = JSON.parse(drop.encryptedDEK);
            const creatorPublicKey = await getUserPublicKey(drop.userId);
            if (creatorPublicKey) {
              oldDek = await decryptDEKForUser(
                parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey
              );
            }
          }
        }

        if (oldDek) {
          const decryptedImage = await decryptData(encryptedImageData, oldDek, drop.imageIv);

          let encryptionKey: CryptoKey | null = null;
          if (isTargetWorkspace) {
            encryptionKey = await getWorkspaceKey(targetWorkspaceId, currentUserId);
          } else {
            const keys = await getUserKeys(currentUserId);
            if (keys && newEncryptedDEK) {
              const parsed = JSON.parse(newEncryptedDEK);
              const creatorPublicKey = await getUserPublicKey(currentUserId);
              if (creatorPublicKey) {
                encryptionKey = await decryptDEKForUser(
                  parsed.encryptedDEK, parsed.iv, creatorPublicKey, keys.privateKey
                );
              }
            }
          }

          if (encryptionKey) {
            const encImg = await encryptData(decryptedImage, encryptionKey);
            const uploadResult = await uploadToR2(encImg.encrypted);
            newImageUrl = uploadResult.url;
            newImageR2Key = uploadResult.key;
            newImageIv = encImg.iv;
            newImageSize = drop.imageSize;
            newImageMimeType = drop.imageMimeType;
          }
        }
      }
    }

    // Step 4: Build the NEW document (addDoc — the original doc is never touched).
    // Standard users can't keep forever: silently copy a forever source as 24h (trusted users and
    // timed sources are unaffected). Best-effort tier read — default to standard on miss/error.
    const sourceOption = drop.expirationOption ?? '2h';
    const sourceIsForever = sourceOption === 'forever' || drop.expiresAt == null;
    let copyExpiration: ExpirationOption = sourceIsForever ? 'forever' : sourceOption;
    if (sourceIsForever) {
      try {
        const userSnap = await getDoc(doc(db, 'users', currentUserId));
        if (userSnap.get('tier') !== 'trusted') copyExpiration = '24h';
      } catch {
        copyExpiration = '24h';
      }
    }
    const expiresAt = getExpirationDate(copyExpiration);
    const docData: Record<string, unknown> = {
      userId: currentUserId, // the copier owns the copy
      type: drop.type,
      name: drop.name,
      createdAt: serverTimestamp(),
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      expirationOption: copyExpiration,
      workspaceId: targetWorkspaceId,
      pinned: false,
      locked: false, // a copy always starts open — the lock never transfers
      category: null,
      categories: [],
    };

    if (drop.type === 'file') {
      docData.fileSize = drop.fileSize;
      docData.mimeType = drop.mimeType;
    }

    if (newContent !== undefined) {
      docData.content = newContent;
    }
    if (newIv !== undefined) {
      docData.iv = newIv;
    }
    if (newEncrypted) {
      docData.encrypted = true;
      if (newEncryptedDEK) {
        docData.encryptedDEK = newEncryptedDEK;
      } else if (isTargetWorkspace) {
        docData.encryptedDEK = null;
      } else {
        // Personal target but no encryptedDEK — fatal, never write a broken drop.
        return { success: false, error: 'Failed to encrypt drop for personal space. Please try again.' };
      }
    } else {
      docData.encrypted = false;
    }

    if (newR2Key !== undefined) {
      docData.r2Key = newR2Key;
      docData.fileUrl = newFileUrl;
    }

    // Mark the copy binary when it was copied from a binary file (streams the URL directly).
    if (newFileFormat) {
      docData.fileFormat = newFileFormat;
    }

    if (newImageUrl !== undefined) {
      docData.imageUrl = newImageUrl;
      docData.imageR2Key = newImageR2Key;
      docData.imageIv = newImageIv;
      docData.imageSize = newImageSize;
      docData.imageMimeType = newImageMimeType;
    } else if (oldImageR2Key) {
      // Image couldn't be re-encrypted — the copy simply has no image (the original keeps its own).
      docData.imageUrl = null;
      docData.imageR2Key = null;
      docData.imageIv = null;
      docData.imageSize = null;
      docData.imageMimeType = null;
    }

    // creatorName: set for workspace targets, null for personal.
    if (isTargetWorkspace) {
      const userDisplayName = await getUserDisplayName(currentUserId);
      docData.creatorName = userDisplayName || undefined;
    } else {
      docData.creatorName = null;
    }

    if (drop.isDrawing) {
      docData.isDrawing = true;
    }

    // Category matching: resolve the source categories into the target space (same as moveDrop).
    // When the caller pre-resolved the whole batch (bulk copy), reuse that map to avoid a race
    // where N concurrent copies each query-before-write and all create the same category doc.
    const sourceCategories = drop.categories || (drop.category ? [drop.category] : []);
    let resolvedNames: string[];
    if (sourceCategories.length > 0) {
      const catMap = resolvedCategories ?? await ensureCategoriesForTarget(targetWorkspaceId, currentUserId, sourceCategories);
      resolvedNames = sourceCategories
        .map(c => catMap.get(c.toLowerCase().trim()))
        .filter((n): n is string => !!n);
    } else {
      resolvedNames = [];
    }
    docData.categories = resolvedNames;

    // Step 5: Create the copy with a single addDoc. The original doc + all its R2 objects
    // are never mutated or deleted.
    try {
      await addDoc(collection(db, DROPS_COLLECTION), docData);
    } catch (writeError) {
      // Create failed after re-uploading the file/image to NEW keys → delete those new objects
      // (a copy always uploads its own keys; the original's objects are never touched). Best-effort;
      // never mask the original write error.
      if (newR2Key) {
        try {
          await deleteFromR2(newR2Key, targetWorkspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned file after copy write failure:', cleanupError);
        }
      }
      if (newImageR2Key) {
        try {
          await deleteFromR2(newImageR2Key, targetWorkspaceId);
        } catch (cleanupError) {
          console.error('Failed to clean up orphaned image after copy write failure:', cleanupError);
        }
      }
      throw writeError;
    }

    // Step 6: NO R2 cleanup — the original owns its objects and must keep them.

    return { success: true };
  } catch (error) {
    console.error('Error copying drop:', error);
    return { success: false, error: 'Failed to copy drop. Please try again.' };
  }
}

async function getUserDisplayName(userId: string): Promise<string | null> {
  // Try to get display name from auth user first
  const currentUser = auth.currentUser;
  if (currentUser && currentUser.uid === userId) {
    return currentUser.displayName || currentUser.email?.split('@')[0] || null;
  }
  // Fallback: try to get from Firestore user document
  return null;
}

// Decrypt a drop's content
export async function decryptDrop(drop: Drop, currentUserId: string): Promise<Drop> {
  // If not encrypted, still need to fetch R2 files
  if (!drop.encrypted) {
    // Binary files live in R2 as real binary. Fetching them as TEXT (below) corrupts the bytes,
    // and no caller needs fileData for a binary drop — playback streams the URL directly, and
    // download/copy fetch the bytes themselves. Skip the wasteful + corrupting whole-file fetch
    // and return the drop as-is. (Legacy data-URI text path + encrypted path are untouched.)
    if (drop.fileFormat === 'binary') {
      return drop;
    }
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

    // AES-GCM ciphertext must be at least 16 bytes (tag size) + IV overhead
    // If the data is too short, it's not valid encrypted content
    if (dataToDecrypt.length < 24) {
      console.warn('Encrypted data too short to decrypt, returning as-is');
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

    // Return drop with decrypted content, mark as decrypted to prevent re-decryption
    return {
      ...drop,
      content: drop.type === 'text' ? decryptedData : drop.content,
      fileData: drop.type === 'file' ? decryptedData : drop.fileData,
      imageData,
      encrypted: false,
    };
  } catch (error) {
    console.error('Failed to decrypt drop:', error);
    return { ...drop, encrypted: false };
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

// Upload a RAW File/Blob directly to R2 as real binary (not base64), so the browser can stream it.
// Accepts a Blob so both createFileDrop (a File, which IS a Blob) and copyDrop (a fetched Blob)
// can use it. Mirrors uploadToR2's flow (idToken -> /api/presign -> presigned PUT) but sends the
// Blob body and its real Content-Type. The Content-Type sent on the PUT MUST match the one presign
// signed (R2 rejects mismatched types with SignatureDoesNotMatch), so we pass blob.type to both.
// uploadToR2 (which uploads ciphertext / data-URI strings) is intentionally left untouched.
async function uploadBinaryFileToR2(blob: Blob): Promise<{ url: string; key: string }> {
  // Get Firebase ID token from current user
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated');
  }

  const idToken = await currentUser.getIdToken();

  // Must match the value presign signs into the URL. Fall back to a generic binary type when the
  // blob didn't carry one.
  const contentType = blob.type || 'application/octet-stream';

  // Step 1: Get presigned URL from our API (signed with contentType)
  const presignResponse = await fetch('/api/presign', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contentType }),
  });

  if (!presignResponse.ok) {
    const error = await presignResponse.json();
    throw new Error(error.error || 'Failed to get upload URL');
  }

  const { presignedUrl, key, fileUrl } = await presignResponse.json();

  // Step 2: Upload the RAW blob directly to R2 (binary stream, no base64 inflate)
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: blob,
  });

  if (!uploadResponse.ok) {
    throw new Error(`R2 binary upload failed: ${uploadResponse.status}`);
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