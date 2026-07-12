import { Drop } from '@/types';

export const DROP_TAG_REGEX = /#\[([^\]]+)\]\(([^)]+)\)/g;
export const USER_TAG_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

// Combined + order-preserving: matches #[name](dropId) (groups 2/3) OR @[name](uid) (groups 5/6)
// in the order they appear, so a message mixing drop-chips and @member-chips parses in sentence
// order. Used by parseMessageContent; the two single-kind regexes above stay exported for callers
// (e.g. extractMentionedUids) that only care about one kind.
const ANY_TAG_REGEX = /(#\[([^\]]+)\]\(([^)]+)\))|(@\[([^\]]+)\]\(([^)]+)\))/g;

export interface ParsedPart {
  type: 'text' | 'tag';
  value?: string;
  name?: string;
  dropId?: string;   // #[name](dropId) — a drop-reference chip
  uid?: string;      // @[name](uid) — a @member mention chip
}

export function parseMessageContent(content: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  ANY_TAG_REGEX.lastIndex = 0;

  while ((match = ANY_TAG_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) {
      parts.push({ type: 'tag', name: match[2], dropId: match[3] });
    } else {
      parts.push({ type: 'tag', name: match[5], uid: match[6] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
}

// Pull the distinct uids from every @[displayName](uid) chip in a serialized message body. Used at
// send time to populate the plaintext, create-only `mentionedUids` field (group chat). De-dupes so
// mentioning the same member twice still notifies them once.
export function extractMentionedUids(content: string): string[] {
  const uids: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  USER_TAG_REGEX.lastIndex = 0;
  while ((match = USER_TAG_REGEX.exec(content)) !== null) {
    const uid = match[2];
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      uids.push(uid);
    }
  }
  return uids;
}

export const HASHTAG_TRIGGER_REGEX = /(?:^|[\s\n])#(\S*)$/;

export function detectHashtagTrigger(textBeforeCursor: string): { query: string; startIndex: number } | null {
  const match = textBeforeCursor.match(HASHTAG_TRIGGER_REGEX);
  if (!match) return null;

  const hashIndex = match[0].startsWith('#') ? match.index! : match.index! + 1;

  return {
    query: match[1],
    startIndex: hashIndex,
  };
}

export const MENTION_TRIGGER_REGEX = /(?:^|[\s\n])@(\S*)$/;

// @member trigger — mirrors detectHashtagTrigger so the editor can open a member picker on `@query`.
// Only used by callers that pass a member source (the group-chat composer); the inline edit box never
// feeds a member list, so @ stays inert there (v1 is composer-only).
export function detectMentionTrigger(textBeforeCursor: string): { query: string; startIndex: number } | null {
  const match = textBeforeCursor.match(MENTION_TRIGGER_REGEX);
  if (!match) return null;

  const atIndex = match[0].startsWith('@') ? match.index! : match.index! + 1;

  return {
    query: match[1],
    startIndex: atIndex,
  };
}

// Flatten parsed content to a plain string: text parts keep their text, #[Name](id) tags
// become just the name. Used for clipboard copy (drop card + preview modal, both themes)
// and the public share page so mention tokens read as the bare name. File drops and
// token-free text have no tags → harmless pass-through (identical string out).
export function contentToPlainText(content: string): string {
  return parseMessageContent(content)
    .map(p => (p.type === 'text' ? p.value : p.name) ?? '')
    .join('');
}
