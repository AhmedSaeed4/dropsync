// Pure URL segmentation for clickable links in message text (Round 11, Option B).
// Splitting text into plain/link segments is kept separate from rendering so it is
// unit-testable (tests/linkify.test.mjs) and reusable by any surface. Security: a link
// segment is ONLY ever produced for a match that starts with the literal http://,
// https:// or www. prefix (www. is normalized to https://), so no other scheme —
// javascript:, data:, vbscript: — can ever reach an href. Segments render as real React
// <a> elements; raw text is never injected as HTML.

export interface LinkSegment {
  type: 'text' | 'link';
  text: string;
  href?: string;
}

// http(s)://… or www.… — stops at whitespace, quotes, angle brackets, and nbsp.
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'\u00A0]+/gi;

// Sentence punctuation that commonly follows a pasted URL but is not part of it.
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '”', '’']);

function countChar(str: string, ch: string): number {
  let n = 0;
  for (const c of str) if (c === ch) n += 1;
  return n;
}

// Trim sentence punctuation off a matched URL tail. A closing bracket stays attached only
// when the URL itself contains its opener (Wikipedia-style paths like …/Foo_(bar)).
function trimUrl(raw: string): string {
  let url = raw;
  while (url.length > 0 && TRAILING_PUNCTUATION.has(url.charAt(url.length - 1))) {
    const last = url.charAt(url.length - 1);
    const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null;
    if (opener && countChar(url, opener) >= countChar(url, last)) break;
    url = url.slice(0, -1);
  }
  return url;
}

export function parseLinks(text: string): LinkSegment[] {
  const parts: LinkSegment[] = [];
  if (!text) return parts;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = trimUrl(match[0]);
    // A match that is nothing but its own prefix ("www.") is not a link — skip it here and
    // it re-joins the surrounding text below.
    if (!url.replace(/^(?:https?:\/\/|www\.)/i, '')) continue;
    if (match.index > lastIndex) parts.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    parts.push({ type: 'link', text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });
  return parts;
}
