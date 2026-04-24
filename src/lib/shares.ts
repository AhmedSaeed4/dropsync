import { auth } from './firebase';

function generateShareId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createShare(options: {
  dropId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  mimeType?: string;
  fileSize?: number;
  imageData?: string;
  youtubeVideoId?: string;
  expiresAt: Date | null;
}): Promise<{ shareId: string; url: string } | null> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return null;

    const idToken = await currentUser.getIdToken();
    const shareId = generateShareId();

    // If there's image data, upload it to R2 via API
    let imageUrl: string | undefined;
    let imageR2Key: string | undefined;
    if (options.imageData) {
      try {
        const uploadRes = await fetch('/api/share', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ imageData: options.imageData }),
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          imageUrl = uploadData.imageUrl;
          imageR2Key = uploadData.imageR2Key;
        } else {
          const err = await uploadRes.json();
          console.error('Share image upload failed:', err);
        }
      } catch (error) {
        console.error('Share image upload failed:', error);
      }
    }

    const res = await fetch('/api/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        shareId,
        dropId: options.dropId,
        type: options.type,
        name: options.name,
        content: options.content,
        mimeType: options.mimeType,
        fileSize: options.fileSize,
        imageUrl,
        imageR2Key,
        youtubeVideoId: options.youtubeVideoId,
        expiresAt: options.expiresAt?.toISOString() || null,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      console.error('Share creation failed:', error);
      return null;
    }

    const url = `${window.location.origin}/s/${shareId}`;
    return { shareId, url };
  } catch (error) {
    console.error('Error creating share:', error);
    return null;
  }
}

export async function deleteSharesForDrop(dropId: string): Promise<void> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    const idToken = await currentUser.getIdToken();

    await fetch(`/api/share?dropId=${dropId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${idToken}`,
      },
    });
  } catch (error) {
    console.error('Error deleting shares for drop:', error);
  }
}
