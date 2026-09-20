'use client';

import type { ReactNode } from 'react';
import { Drop } from '@/types';
import { parseMessageContent } from '@/lib/dropTagUtils';
import { parseLinks } from '@/lib/linkify';
import { Tooltip } from './Tooltip';

interface DropMentionContentProps {
  // Decrypted text body — may contain #[Name](id) drop tokens and @[Name](uid) @member tokens.
  content: string;
  // Current space's drops — used to resolve chip targets (existence + current name).
  allDrops?: Drop[];
  // Clicking a resolvable chip opens the linked drop. Callers pass their preview handler.
  onPreview?: (drop: Drop) => void;
  // Full className for a chip whose target still exists.
  foundClassName: string;
  // Full className for a chip whose target was deleted / can't be resolved.
  deletedClassName: string;
  // Full className for an inline @[Name](uid) @member chip (group chat only). Single style — an
  // ex-member's chip keeps the baked name, so there is no found/deleted split for users. Optional:
  // drop cards / preview modals render drop content (no @ chips), so they omit it.
  userMentionClassName?: string;
}

/**
 * Renders a decrypted text body inline: plain text → <span>, #[Name](id) → an inline
 * clickable chip mid-sentence (NOT pulled into a separate row). Shared by the drop cards
 * (DropItem / EditorialDropItem) and the preview modals so all four chip surfaces stay
 * identical. The caller supplies theme-specific class strings; this component owns the
 * parse → map → chip logic.
 */
// Shared segment renderer: plain text → <span>, recognized URL → a coral-signature link
// (Round 11, Option B). stopPropagation matches the mention chips: a link click opens the
// LINK in a new tab, never the card/modal/row it sits inside. Links are real <a> elements
// built from parsed segments — raw text is never injected as HTML. On hover the link shows
// the app's standard dark tooltip bubble (the DropZone lock's Tooltip), replacing the
// browser-default box; break-all lets a long URL still wrap inside the tooltip's
// inline-flex wrapper.
function linkTip(href: string): string {
  const bare = href.replace(/^https?:\/\//i, '');
  return bare.length > 48 ? `${bare.slice(0, 48)}…` : bare;
}

function renderLinkified(text: string): ReactNode[] {
  return parseLinks(text).map((seg, j) =>
    seg.type === 'link' ? (
      <Tooltip key={j} content={linkTip(seg.href ?? seg.text)}>
        <a
          href={seg.href}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-link break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {seg.text}
        </a>
      </Tooltip>
    ) : (
      <span key={j}>{seg.text}</span>
    )
  );
}

/** Plain-text renderer with the same clickable links DropMentionContent gives its text
 *  parts — for message bodies with no mention chips (the AI-chat user bubbles). */
export function LinkedText({ text }: { text: string }) {
  return <>{renderLinkified(text)}</>;
}

export function DropMentionContent({ content, allDrops = [], onPreview, foundClassName, deletedClassName, userMentionClassName = '' }: DropMentionContentProps) {
  return (
    <>
      {parseMessageContent(content).map((part, i) => {
        if (part.type === 'text') return <span key={i}>{renderLinkified(part.value ?? '')}</span>;
        if (part.uid !== undefined) {
          // @member chip — styled inline, non-interactive (no target to open). Renders the baked name.
          return <span key={i} className={userMentionClassName}>{part.name}</span>;
        }
        const found = allDrops.find(d => d.id === part.dropId);
        const exists = !!found;
        // Show the linked drop's current name when it exists (so renames update);
        // otherwise fall back to the name baked into the token.
        const displayName = found ? found.name : part.name;
        return (
          <button
            key={i}
            type="button"
            disabled={!exists}
            title={exists ? displayName : 'drop deleted'}
            // stopPropagation so a chip click inside a clickable card / modal opens the
            // LINKED drop, not the card/modal it sits in.
            onClick={(e) => { e.stopPropagation(); if (found && onPreview) onPreview(found); }}
            className={exists ? foundClassName : deletedClassName}
          >
            {displayName}
          </button>
        );
      })}
    </>
  );
}
