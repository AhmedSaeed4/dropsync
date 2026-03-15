export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
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
  fileData?: string; // base64 encoded file (encrypted if encrypted=true)
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
}

export interface DropFormData {
  type: 'file' | 'text';
  name: string;
  content?: string;
  file?: File;
}