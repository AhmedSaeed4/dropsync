'use client';

// Wide-desktop visible-window renderer (Round 9, Order 16 Stage A; Stages D+E
// in Order 18). Three render branches mirror the legacy narrow list exactly
// (EditorialDropList's branch order: drag, then animate, then plain):
//  - drag    (Manual sort + fine pointer): sortable rows; the stage row IS the
//            dnd-kit node; NO motion wrappers (the legacy drag branch has none).
//            dnd-kit's own autoscroll is disabled for this branch (the parent's
//            DndContext passes autoScroll={false}); the controller's edge
//            scheduler owns scrolling via win.edgeScroll below.
//  - animate (unfiltered + motion allowed): the legacy add/remove animation,
//            value-for-value (layout + fade/scale in, fade/scale out, popLayout).
//            Entry plays ONLY for genuinely new/returned drops (classifyNewIds);
//            scroll mounts render in place, and scroll unmount exits happen far
//            outside the viewport (the row buffer) so they are never painted.
//  - plain   (filtered search or reduced motion): rows at their final position
//            with no motion (the Stage A behavior).
// The engine contract is unchanged in every branch: same stage div, same
// data-row-id wrappers the controller measures, same single correction owner.
import { memo, useEffect, useMemo, useRef, type ComponentProps, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Drop, Workspace } from '@/types';
import { EditorialDropItem } from './EditorialDropItem';
import { isReminderFiredShared, isReminderGlowingForViewer } from '@/lib/drops';
import { MemberInfo } from '@/lib/workspaces';
import { classifyNewIds, eligibleDragIds } from '@/lib/editorialWindowModel';
import { useEditorialWindow } from '@/hooks/useEditorialWindow';

// Stage E's add/remove classification memory (the heightStore pattern:
// plain module state, written after every commit and read during render -
// never a React ref, never component state, so recording a commit renders
// nothing). knownScope tracks the previous commit's scope so a workspace
// switch (even switching back) animates the incoming rows the way the
// legacy list did when it re-keyed its children.
let knownScope: string | null = null;
const knownIdsByScope = new Map<string, Set<string>>();

// Sortable stage row (Manual mode). Same pattern and same values as the
// legacy SortableEditorialDropItem: dnd-kit's drag transform composes with the
// row's inline top (transform + top coexist), the z/opacity treatment matches,
// and the controller's height measurement is unaffected (offsetHeight ignores
// transforms).
const SortableWindowRow = memo(function SortableWindowRow({
  top,
  ...cardProps
}: ComponentProps<typeof EditorialDropItem> & { top: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cardProps.drop.id });
  // Same memoization rationale as the legacy wrapper: attributes/listeners are
  // referentially stable across drag frames, so the combined handle object is
  // too and the card's memo holds while dragging.
  const dragHandleProps = useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners]);
  return (
    <div
      ref={setNodeRef}
      data-row-id={cardProps.drop.id}
      style={{
        position: 'absolute',
        top,
        left: 12,
        right: 12,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition: transition ?? undefined,
        zIndex: isDragging ? 50 : undefined,
        opacity: isDragging ? 0.85 : undefined,
      }}
    >
      <EditorialDropItem {...cardProps} showDragHandle dragHandleProps={dragHandleProps} />
    </div>
  );
});

// Animated stage row (the everyday unfiltered branch). The motion values are
// the legacy AnimatedDropRow's, byte-for-byte (Order 18 Stage E owner lock:
// "exactly the same as before"). isNew only shapes the INITIAL state — rows
// mounted by scrolling get `false` and never fade/scale in.
const AnimatedWindowRow = memo(function AnimatedWindowRow({
  top,
  isNew,
  ...cardProps
}: ComponentProps<typeof EditorialDropItem> & { top: number; isNew: boolean }) {
  return (
    <motion.div
      data-row-id={cardProps.drop.id}
      layout
      initial={isNew ? { opacity: 0, scale: 0.97 } : false}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      style={{ position: 'absolute', top, left: 12, right: 12 }}
    >
      <EditorialDropItem {...cardProps} />
    </motion.div>
  );
});

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
  enableDrag,
  animate,
  activeDragId,
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
  // Order 18 Stage D: Manual sort + fine pointer.
  enableDrag: boolean;
  // Order 18 Stage E: the legacy animation gate (unfiltered + motion allowed).
  animate: boolean;
  // The wide DndContext's active drag id, for slot retention + edge autoscroll.
  activeDragId?: string | null;
}) {
  const now = new Date();
  const scope = currentWorkspace?.id ?? 'personal';
  const ids = useMemo(() => filteredDrops.map((d) => d.id), [filteredDrops]);
  // The renderer owns the stage's standard object ref and hands it to the
  // controller hook.
  const stageRef = useRef<HTMLDivElement | null>(null);
  // While a drag is active the source row's slot stays mounted even if the
  // window slides past it (plan §1.8) — no overlay needed.
  const retainedIds = useMemo(
    () => (activeDragId ? new Set<string>([activeDragId]) : undefined),
    [activeDragId]
  );
  const win = useEditorialWindow(scope, ids, stageRef, retainedIds);
  const edgeScroll = win.edgeScroll;
  const dropById = useMemo(() => new Map(filteredDrops.map((d) => [d.id, d])), [filteredDrops]);

  // Drag edge autoscroll (controller-owned scheduler). While a drag is active,
  // pointer moves feed the scroller position; the loop inside the controller
  // writes clamped scrollTop and the native scroll handler does the window
  // bookkeeping. Cleanup stops the loop on drop/cancel/unmount.
  useEffect(() => {
    if (!activeDragId) return;
    const onMove = (e: PointerEvent) => edgeScroll(e.clientY);
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      edgeScroll(null);
    };
  }, [activeDragId, edgeScroll]);

  // Add/remove classification (Stage E): the ids genuinely new since the
  // previous commit, read from the module-level memory (heightStore
  // pattern). The effect below records this commit's list - no state,
  // no extra render.
  const prevIds = knownIdsByScope.get(scope) ?? null;
  const scopeChanged = knownScope !== null && knownScope !== scope;
  const newIds = useMemo(
    () => classifyNewIds(scopeChanged ? null : prevIds, scopeChanged, ids),
    [prevIds, scopeChanged, ids]
  );
  useEffect(() => {
    knownIdsByScope.set(scope, new Set(ids));
    knownScope = scope;
  });

  // The sortable set is the FULL eligible sequence (same predicate as the
  // legacy list), so a drag's landing merges against the complete order even
  // though only window rows are mounted.
  const sortableIds = enableDrag ? eligibleDragIds(filteredDrops, (d) => isReminderFiredShared(d, now)) : [];
  const sortableIdSet = new Set(sortableIds);

  const cardPropsFor = (drop: Drop): ComponentProps<typeof EditorialDropItem> => {
    const moveIdx = manualIndexById.get(drop.id);
    return {
      drop,
      onDelete,
      onPreview,
      onEdit,
      selected: selectedIds.has(drop.id),
      onSelect: toggleSelect,
      selectionMode,
      theme,
      currentUserId,
      reminderGlow: isReminderGlowingForViewer(drop, currentUserId ?? null, now),
      canMutate: !!currentUserId && (currentUserId === drop.userId || (!!currentWorkspace && currentUserId === currentWorkspace.ownerId)),
      onPin,
      onUnpin: onPin,
      allDrops,
      onJoinCall,
      members: workspaceMembers,
      isReopenCallId,
      hoverable,
      showMoveControls: moveIdx !== undefined && !enableDrag,
      canMoveUp: moveIdx !== undefined && moveIdx > 0,
      canMoveDown: moveIdx !== undefined && moveIdx < manualCount - 1,
      onMoveUp: moveUp,
      onMoveDown: moveDown,
      virtualMode: true,
      resourceScope: scope,
    };
  };

  const stageStyle: CSSProperties = { position: 'relative', height: win.totalHeight, overflow: 'hidden' };

  if (enableDrag) {
    return (
      <div ref={stageRef} style={stageStyle}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {win.rows.map(({ id, top }) => {
            const drop = dropById.get(id);
            if (!drop) return null;
            // WV-4 (Order 21): tier rows (live calls, fired reminders, pinned)
            // are NOT sortable nodes - the legacy branch renders them outside
            // its SortableContext. They keep their window slot (the plain
            // branch's wrapper shape) but supply no grip and can never be a
            // drag source or a collision target.
            if (!sortableIdSet.has(id)) {
              return (
                <div key={id} data-row-id={id} style={{ position: 'absolute', top, left: 12, right: 12 }}>
                  <EditorialDropItem {...cardPropsFor(drop)} />
                </div>
              );
            }
            return <SortableWindowRow key={id} top={top} {...cardPropsFor(drop)} />;
          })}
        </SortableContext>
      </div>
    );
  }

  if (animate) {
    return (
      <div ref={stageRef} style={stageStyle}>
        <AnimatePresence initial={false} mode="popLayout">
          {win.rows.map(({ id, top }) => {
            const drop = dropById.get(id);
            if (!drop) return null;
            return <AnimatedWindowRow key={id} top={top} isNew={newIds.has(id)} {...cardPropsFor(drop)} />;
          })}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div ref={stageRef} style={stageStyle}>
      {win.rows.map(({ id, top }) => {
        const drop = dropById.get(id);
        if (!drop) return null;
        return (
          <div key={id} data-row-id={id} style={{ position: 'absolute', top, left: 12, right: 12 }}>
            <EditorialDropItem {...cardPropsFor(drop)} />
          </div>
        );
      })}
    </div>
  );
});
