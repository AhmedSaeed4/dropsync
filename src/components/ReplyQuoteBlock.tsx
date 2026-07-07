'use client';

import type { GroupChatMessage } from '@/types';
import { contentToPlainText } from '@/lib/dropTagUtils';

// One-line snippet from a decrypted body: flatten #[Name](id) chips to the BARE name (so a chip reads
// as its name, NOT a raw "#[Name](id)" token), collapse all whitespace to a single space, then
// truncate ~60 chars with an ellipsis. Plain text only — chips stay CLICKABLE only in the real
// message body (DropMentionContent), never here. Reuses contentToPlainText (no reinvented parser,
// no raw string.slice that could cut a #[Name](id) token in half).
function snippetOf(content: string): string {
  const plain = contentToPlainText(content).replace(/\s+/g, ' ').trim();
  if (plain.length <= 60) return plain;
  // Truncate by CODE POINT: Array.from iterates a string by code point, keeping astral surrogate
  // pairs (e.g. 🎉) intact. String.prototype.slice operates on UTF-16 code units and would split a
  // surrogate pair — or a base char + combining mark — at the boundary, leaving a lone surrogate
  // that renders as � (U+FFFD).
  return Array.from(plain).slice(0, 60).join('') + '…';
}

interface ReplyQuoteBlockProps {
  // id of the message being quoted.
  replyToMessageId: string;
  // LIVE in-memory message array — resolved each render, so edits/deletes to the parent reflect
  // immediately (an id pointer, not a snapshot).
  groupMessages: GroupChatMessage[];
  onJump: () => void;
  // Corner rounding to match the panel's bubbles (classic sharp, editorial/minimal rounded).
  roundedClassName?: string;
}

/**
 * Compact quote block rendered ABOVE a reply's own body (WhatsApp/iMessage style): an accent bar +
 * the parent sender's name + a one-line plain-text snippet. Tapping it smooth-scrolls to + flash-
 * highlights the parent (onJump → useMessageScroll.jumpToMessage).
 *
 * Theme strategy: it lives INSIDE a message bubble, whose background ranges coral → cream →
 * near-black across themes (and own vs other differ), so a fixed text/bar color can't span them
 * (dark text is invisible on a near-black own bubble). It therefore uses the bubble's INHERITED text
 * color (currentColor) + opacity for the bar / name / snippet — readable on every bubble in every
 * theme with no per-message class matrix. The whole block is a button; onClick stopPropagation so it
 * never triggers the panel-root focus-on-click, and only jumps when the parent is still loaded.
 *
 * If the parent is gone (hard-deleted via deleteGroupMessage = real deleteDoc, or scrolled off the
 * loaded window) it collapses to a muted "Original message unavailable" line.
 *
 * Rendered REGARDLESS of showSender grouping — it's per-message context, not a sender header.
 */
export function ReplyQuoteBlock({
  replyToMessageId,
  groupMessages,
  onJump,
  roundedClassName = 'rounded',
}: ReplyQuoteBlockProps) {
  const parent = groupMessages.find((m) => m.id === replyToMessageId);

  return (
    <button
      type="button"
      aria-label={parent ? `Jump to ${parent.senderName}'s message` : 'Original message unavailable'}
      onClick={(e) => { e.stopPropagation(); if (parent) onJump(); }}
      className={`mb-1 flex w-full items-stretch gap-1.5 overflow-hidden text-left ${roundedClassName}`}
    >
      <span aria-hidden="true" className="w-0.5 shrink-0 rounded-full bg-current opacity-50" />
      <span className="min-w-0 flex-1 py-0.5">
        {parent ? (
          <>
            <span className="block truncate text-[10px] font-semibold leading-tight opacity-90">
              {parent.senderName}
            </span>
            <span className="block truncate text-[10px] leading-tight opacity-60">
              {snippetOf(parent.content)}
            </span>
          </>
        ) : (
          <span className="block truncate text-[10px] italic leading-tight opacity-50">
            Original message unavailable
          </span>
        )}
      </span>
    </button>
  );
}

interface ReplyPreviewBarProps {
  // The message being replied to (the in-memory doc — live, so the snippet tracks edits).
  replyTo: GroupChatMessage;
  onClear: () => void;
  // Explicit theme class strings — unlike the quote block, this lives in the input area which has NO
  // inherited text color (the panel root doesn't set one), so it MUST pass concrete colors.
  containerClassName: string;
  iconClassName: string;
  nameClassName: string;
  snippetClassName: string;
  closeBtnClassName: string;
}

/**
 * Slim "↩ replying to @name — snippet" bar rendered ABOVE the composer while a reply is queued,
 * with an ✕ to dismiss (clearReply). SHARED markup between the classic + editorial panels — only
 * the placement differs (classic: inside the input wrapper above the <form>; editorial: an in-flow
 * child of the input-area wrapper above the flex row, since the editorial editor is a wrapper-less
 * direct flex child).
 */
export function ReplyPreviewBar({
  replyTo,
  onClear,
  containerClassName,
  iconClassName,
  nameClassName,
  snippetClassName,
  closeBtnClassName,
}: ReplyPreviewBarProps) {
  return (
    <div className={`mb-1.5 flex items-center gap-1.5 px-1 py-1 ${containerClassName}`}>
      <svg className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
      </svg>
      <span className={`shrink-0 text-[10px] font-semibold ${nameClassName}`}>
        Replying to {replyTo.senderName}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[10px] ${snippetClassName}`}>
        {snippetOf(replyTo.content)}
      </span>
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={(e) => { e.stopPropagation(); onClear(); }}
        className={`shrink-0 ${closeBtnClassName}`}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
