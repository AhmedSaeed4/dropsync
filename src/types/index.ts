export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  providerId?: 'password' | 'google.com';
}

export type ExpirationOption = '1h' | '2h' | '6h' | '24h' | 'forever';

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  inviteCode: string;
  createdAt: Date;
}

export interface Drop {
  id: string;
  userId: string;
  type: 'file' | 'text';
  name: string;
  content?: string;
  fileData?: string; // base64 encoded file (encrypted if encrypted=true) - KEEP for backward compatibility
  fileUrl?: string;  // R2 URL for encrypted file (NEW)
  r2Key?: string;    // R2 object key for deletion (NEW)
  fileSize?: number;
  mimeType?: string;
  createdAt: Date;
  expiresAt: Date | null; // null = forever
  expirationOption?: ExpirationOption;
  workspaceId: string | null; // null = personal drop
  // Encryption fields
  encrypted?: boolean;
  iv?: string; // Initialization vector for content encryption
  encryptedDEK?: string; // For personal drops: DEK encrypted with user's key
  encryptedDEKs?: { [userId: string]: { encryptedDEK: string; iv: string } }; // For workspace drops
  // Category field
  category?: string; // 'password', 'link', or custom category name
  // Creator name for workspace drops
  creatorName?: string;
}

export interface Category {
  id: string;
  name: string;
  workspaceId: string | null; // null = personal workspace
  createdBy: string;
  createdAt: Date;
}

export interface DropFormData {
  type: 'file' | 'text';
  name: string;
  content?: string;
  file?: File;
}