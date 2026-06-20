'use client';

import { Drop } from '@/types';
import { parseMessageContent } from '@/lib/dropTagUtils';

interface DropMentionContentProps {
  // Decrypted text body — may contain #[Name](id) mention tokens.
  content: string;
  // Current space's drops — used to resolve chip targets (existence + current name).
  allDrops?: Drop[];
  // Clicking a resolvable chip opens the linked drop. Callers pass their preview handler.
  onPreview?: (drop: Drop) => void;
  // Full className for a chip whose target still exists.
  foundClassName: string;
  // Full className for a chip whose target was deleted / can't be resolved.
  deletedClassName: string;
}

/**
 * Renders a decrypted text body inline: plain text → <span>, #[Name](id) → an inline
 * clickable chip mid-sentence (NOT pulled into a separate row). Shared by the drop cards
 * (DropItem / EditorialDropItem) and the preview modals so all four chip surfaces stay
 * identical. The caller supplies theme-specific class strings; this component owns the
 * parse → map → chip logic.
 */
export function DropMentionContent({ content, allDrops = [], onPreview, foundClassName, deletedClassName }: DropMentionContentProps) {
  return (
    <>
      {parseMessageContent(content).map((part, i) => {
        if (part.type === 'text') return <span key={i}>{part.value}</span>;
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
