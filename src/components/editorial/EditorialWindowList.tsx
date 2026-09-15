'use client';

// Wide-desktop visible-window renderer (Round 9, Order 16 Stage A).
// Stage A scope: the window itself — measured real heights, natural native
// scrolling, the controller (useEditorialWindow) as the single correction
// owner. Drag and add/remove animations are deliberately DISABLED here until
// Stages D/E of the Order 15 plan: rows render plain at their final position
// with no motion wrappers, and the sortable path stays legacy-only. Card
// revisit-decrypt remains each card's own in-view behavior until Stage B.
import { memo, useMemo, useRef } from 'react';
import { Drop, Workspace } from '@/types';
import { EditorialDropItem } from './EditorialDropItem';
import { isReminderGlowingForViewer } from '@/lib/drops';
import { MemberInfo } from '@/lib/workspaces';
import { useEditorialWindow } from '@/hooks/useEditorialWindow';

export const EditorialWindowList = memo(function EditorialWindowList({
  filteredDrops,
  manualIndexById,
  manualCount,
  selectedIds,
  toggleSelect,
  selectionMode,
  theme,
  currentUserId,
  currentWorkspace,
  onDelete,
  onPin,
  onPreview,
  onEdit,
  allDrops,
  onJoinCall,
  workspaceMembers,
  isReopenCallId,
  hoverable,
  moveUp,
  moveDown,
}: {
  filteredDrops: Drop[];
  manualIndexById: Map<string, number>;
  manualCount: number;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  selectionMode: boolean;
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  currentWorkspace?: Workspace | null;
  onDelete: (drop: Drop) => void;
  onPin: (drop: Drop) => Promise<void> | void;
  onPreview: (drop: Drop) => void;
  onEdit?: (drop: Drop) => void;
  allDrops?: Drop[];
  onJoinCall?: (drop: Drop) => void;
  workspaceMembers?: MemberInfo[];
  isReopenCallId?: string;
  hoverable?: boolean;
  moveUp: (id: string) => void;
  moveDown: (id: string) => void;
}) {
  const now = new Date();
  const ids = useMemo(() => filteredDrops.map((d) => d.id), [filteredDrops]);
  // The renderer owns the stage's standard object ref and hands it to the
  // controller hook.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const win = useEditorialWindow(currentWorkspace?.id ?? 'personal', ids, stageRef);
  const dropById = useMemo(() => new Map(filteredDrops.map((d) => [d.id, d])), [filteredDrops]);

  return (
    // Explicit-height stage: window boundaries add/remove no layout height and
    // the controller owns every position. overflow-hidden keeps an
    // underestimated descendant from silently enlarging native scrollHeight
    // (card menus are portaled, so clipping is safe).
    <div ref={stageRef} style={{ position: 'relative', height: win.totalHeight, overflow: 'hidden' }}>
      {win.rows.map(({ id, top }) => {
        const drop = dropById.get(id);
        if (!drop) return null;
        const moveIdx = manualIndexById.get(drop.id);
        // WV-1 (Order 17): 12px side insets - the legacy list's p-3. The stage's
        // absolutely positioned rows ignore stage padding, so the inset lives on
        // the row itself; narrower cards re-measure via the rows' own
        // ResizeObservers and the controller absorbs the height deltas.
        return (
          <div key={id} data-row-id={id} style={{ position: 'absolute', top, left: 12, right: 12 }}>
            <EditorialDropItem
              drop={drop}
              onDelete={onDelete}
              onPreview={onPreview}
              onEdit={onEdit}
              selected={selectedIds.has(drop.id)}
              onSelect={toggleSelect}
              selectionMode={selectionMode}
              theme={theme}
              currentUserId={currentUserId}
              reminderGlow={isReminderGlowingForViewer(drop, currentUserId ?? null, now)}
              canMutate={!!currentUserId && (currentUserId === drop.userId || (!!currentWorkspace && currentUserId === currentWorkspace.ownerId))}
              onPin={onPin}
              onUnpin={onPin}
              allDrops={allDrops}
              onJoinCall={onJoinCall}
              members={workspaceMembers}
              isReopenCallId={isReopenCallId}
              hoverable={hoverable}
              showMoveControls={moveIdx !== undefined}
              canMoveUp={moveIdx !== undefined && moveIdx > 0}
              canMoveDown={moveIdx !== undefined && moveIdx < manualCount - 1}
              onMoveUp={moveUp}
              onMoveDown={moveDown}
              virtualMode
              resourceScope={currentWorkspace?.id ?? 'personal'}
            />
          </div>
        );
      })}
    </div>
  );
});
