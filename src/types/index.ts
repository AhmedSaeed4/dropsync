export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  providerId?: 'password' | 'google.com';
}

export type ExpirationOption = '1h' | '2h' | '4h' | '6h' | '24h' | 'forever';

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
  type: 'file' | 'text' | 'call';
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
  // Image attachment (text drops with image)
  imageUrl?: string; // R2 URL for attached image
  imageR2Key?: string; // R2 object key for deletion
  imageSize?: number;
  imageMimeType?: string;
  imageIv?: string; // IV for image encryption
  imageData?: string; // Runtime only: decrypted base64 image data
  // Category fields
  category?: string; // Legacy: single category string
  categories?: string[]; // New: array of category names (max 3)
  // Creator name for workspace drops
  creatorName?: string;
  // Pin state
  pinned?: boolean;
  // Drawing state
  isDrawing?: boolean;
  // Lock state — when true only the creator/workspace owner can edit/move/delete the drop
  locked?: boolean;
  // Reminder state (in-app only — pure client-side on the drop doc; no server route, no FCM).
  // reminderAt != null means the reminder is ON (NO separate boolean). reminderSetByUid = the uid of
  // whoever set/last-edited the reminder (the "creator" for the keeps-glowing rule).
  // reminderDismissedBy = uid of whoever dismissed, or null. See isReminderFiredShared /
  // isReminderGlowingForViewer in lib/drops.ts.
  reminderAt?: Date | null;
  reminderSetByUid?: string | null;
  reminderDismissedBy?: string | null;
  // Storage format flag. 'binary' = the R2 object is real binary (streamable); absence (legacy)
  // = data-URI text the player must fetch + decode. Only set on NEW unencrypted large files.
  fileFormat?: 'binary';
  // Optional provenance marker written by workspace archive import. It is used only to warn about
  // importing the same archive into the same target twice; it carries no encryption authority.
  importedFromArchiveId?: string;
  // ---- Call-drop-only fields (type === 'call'). A call drop carries NO content/fileUrl/
  // encrypted/pinned/locked/reminderAt/categories (those stay undefined). callHostUid is DISPLAY
  // ONLY (the host name reuses creatorName). callStartedAt (serverTimestamp) drives the "LIVE · Xm"
  // age. callParticipantUids is the roster mirror (drop-card count + mesh peer list) AND the
  // single Firestore field the rules + routes key on. callState is 'live' while active
  // (route-managed; clients never write the call doc). See lib/liveCallSignaling + /api/call/*.
  callHostUid?: string;
  callStartedAt?: Date | null;
  callParticipantUids?: string[];
  callState?: string;
  trustedParticipantCount?: number;
  callLimitDeadlineAt?: Date | null;
  callEndedAt?: Date | null;
  callEndReason?: string;
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

export interface GroupChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;  // decrypted plaintext at runtime
  encrypted: boolean;
  iv: string;
  createdAt: Date;
  // Edit metadata — optional so pre-edit / legacy messages stay valid. editedAt is DISPLAY-ONLY and
  // MUST NEVER be used as a comparator in the unread counter, the foreground notification listener,
  // useInPanelMarkRead, or markWorkspaceChatRead (those stay keyed exclusively on createdAt).
  edited?: boolean;
  editedAt?: Date | null;
  editCount?: number;
  // Quote-reply pointer — the id of the message this one is replying to. DISPLAY-ONLY: a plaintext
  // id like senderId/senderName (NEVER passed through encryptData/decryptData — no new crypto). Set
  // once at CREATE only (the firestore.rules update rule's hasOnly allowlist excludes it, so it is
  // immutable after create; editing a replied message preserves the pointer). Like editedAt it is
  // display-only context and MUST NEVER feed the unread counter / read-state / foreground listener.
  replyToMessageId?: string;
}
