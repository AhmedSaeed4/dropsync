import { Drop } from '@/types';

export const DROP_TAG_REGEX = /#\[([^\]]+)\]\(([^)]+)\)/g;

export interface ParsedPart {
  type: 'text' | 'tag';
  value?: string;
  name?: string;
  dropId?: string;
}

export function parseMessageContent(content: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DROP_TAG_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'tag', name: match[1], dropId: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
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
