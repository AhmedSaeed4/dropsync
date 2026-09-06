'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Category, Drop, ExpirationOption, Workspace } from '@/types';
import { createFileDrop, createTextDrop, formatReminderFire } from '@/lib/drops';
import type { ReminderUnit } from '@/lib/drops';
import { dedupeCategoryNames } from '@/lib/categories';
import { getEditorialThemeColors } from '../editorialTheme';
import { Toast } from '@/components/Toast';
import { ForeverLockedModal } from '../../ForeverLockedModal';
import { DrawingCanvas, BG_COLORS } from '../../DrawingCanvas';
import { EditorialDropPickerRow } from '../EditorialDropPickerRow';
import { useUserTier } from '@/hooks/useUserTier';
import { useReminder, REMINDER_PRESETS } from '@/hooks/useReminder';
import { useNow } from '@/hooks/useNow';
import { useMentionEditor } from '@/hooks/useMentionEditor';
import { useVoiceTranscribe } from '@/hooks/useVoiceTranscribe';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

type Theme = 'light' | 'dark' | 'minimal';
type StartMode = 'file' | 'text' | 'draw';

interface MobileCreateViewProps {
  theme: Theme;
  // The signed-in user (shell's `user`) — createTextDrop/createFileDrop's userId + creatorName.
  user: any;
  currentUserId: string | null;
  currentWorkspace: Workspace | null;
  currentWorkspaceId: string | null;
  // The shell's members array (resolved MemberInfo[]) threaded into the create calls — typed
  // any[] per the order's interface; createTextDrop/createFileDrop declare string[] and do not
  // read the value (legacy compat param), so the shape is inert at runtime.
  workspaceMembers: any[];
  drops: Drop[];
  categories: Category[];
  onCreateCategory: (name: string) => Promise<string | null>;
  // Successful Create → the shell switches to the Drops tab (prototype :1527).
  onCreated: () => void;
  // Whether Create is the visible tab (the shell's activeTab === 'create'). Going inactive
  // cancels a live dictation (OWNER REQUEST #11 / D19): leaving Create never leaves the mic on.
  active: boolean;
}

// The expiry pills carry the prototype's SHORT face (1h/2h/6h/24h/Forever — prototype :557-563),
// not the desktop modal's spelled-out labels. Same five values, same order as EXPIRATION_OPTIONS.
const EXPIRY_PILLS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: 'forever', label: 'Forever' },
];

// The two built-in category pills (port of EditorialTextModal :59-62).
const BUILT_IN_CATEGORIES = [
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

// The Create tab (#16): mode-driven attach strip (File · Text · Draw), the REAL mention editor
// as the body, the REAL Excalidraw canvas for drawings, and the real create funnels
// (createTextDrop / createFileDrop) — the prototype's mocks are superseded per the locked
// precedence rulings (Order 3 §3). Keep-mounted by the shell (D16 rider): the draft survives
// tab switches; only a successful Create clears it.
export function MobileCreateView({
  theme,
  user,
  currentWorkspace,
  currentWorkspaceId,
  workspaceMembers,
  drops,
  categories,
  onCreateCategory,
  onCreated,
  active,
}: MobileCreateViewProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const [mode, setMode] = useState<StartMode>('file');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [initialScene, setInitialScene] = useState<{ elements: ExcalidrawElement[]; appState: Omit<AppState, 'offsetTop' | 'offsetLeft' | 'width' | 'height'>; files?: BinaryFiles } | null>(null);
  const [extractingScene, setExtractingScene] = useState(false);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [hasDrawn, setHasDrawn] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const [locked, setLocked] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCategoryName, setCustomCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Strip's "Uploading… · N/M" progress while the file-mode loop runs (null = idle).
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [showForeverLocked, setShowForeverLocked] = useState(false);
  const [switchSheet, setSwitchSheet] = useState(false);
  // R7 full-screen editor panel — open, the editor body renders in the panel instead of the
  // card (exactly one mount at a time).
  const [editorExpanded, setEditorExpanded] = useState(false);
  // R10 card stretch: the card body's height in px (84 = the built 3b field). The grabber on
  // the card's bottom edge drags it between 84 and ~55% of the viewport (demo-card-stretch).
  const [bodyH, setBodyH] = useState(84);
  const [cardStretching, setCardStretching] = useState(false);
  // R10 resizable sheet: sheetFull = snapped FULL, else mid (~60dvh); sheetDragH is the live
  // px height while a handle drag is running (null = use the dvh snap target).
  const [sheetFull, setSheetFull] = useState(false);
  const [sheetDragH, setSheetDragH] = useState<number | null>(null);
  // Toasts float ABOVE the navbar (mobileFloat) and remount per message (key=seq) so each
  // message gets its own full dismiss timer.
  const [toast, setToast] = useState<{ msg: string; seq: number } | null>(null);
  const toastSeqRef = useRef(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Voice's onTranscript reads the body from outside the render flow (latest-ref callback);
  // the mirror keeps that read fresh without waiting for a commit.
  const contentRef = useRef(content);
  contentRef.current = content;

  const { tier, loading: tierLoading } = useUserTier();

  // In-app reminder — create mode (no maxDate/initialReminderAt; the hook derives the cap
  // from the chosen expiry option).
  const {
    reminderEnabled, reminderPreset, reminderCustomValue, reminderCustomUnit,
    reminderAt: reminderAtValue, reminderInvalid: reminderInvalidValue, warning: reminderWarningValue,
    setReminderEnabled, setReminderPreset, setReminderCustomValue, setReminderCustomUnit,
    pickerActive,
  } = useReminder(expiration);
  // Live "now" for the fire-time preview (same 30s tick as the desktop modal).
  const now = useNow();
  const reminderFire = reminderEnabled && !reminderInvalidValue && reminderAtValue
    ? formatReminderFire(reminderAtValue, now)
    : null;

  // contentEditable mention editor — the REAL body (ruling: not the prototype's textarea).
  // Chips render live; the saved value stays the plain #[Name](id) token string.
  const mentionChipBase = `inline-flex items-center mx-0.5 my-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${font}`;
  const mention = useMentionEditor({
    content,
    setContent,
    allDrops: drops,
    foundClassName: `${mentionChipBase} ${tc.activePillBg} ${tc.activePillText}`,
    deletedClassName: `${mentionChipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`,
  });

  const showToast = (msg: string) => {
    toastSeqRef.current += 1;
    setToast({ msg, seq: toastSeqRef.current });
  };

  // #26: typing / paste / the # chip / a transcript IS text intent — slide the chip to Text
  // (one-way; never fires once a drawing is attached). The prototype read its live DOM; here
  // the title comes from the input node (state lags one keystroke) and an optional `incomingBody`
  // covers programmatic writers (the voice transcript) whose content isn't committed yet.
  // Silent per R9 — the "Switched to Text" toast is vetoed (README #26 amendment); the
  // auto-switch itself (chip slide, strip swap, one-way, programmatic triggers) is unchanged.
  const autoTextMode = (incomingBody?: string) => {
    if (mode === 'text' || drawingFile) return;
    const titleNow = titleInputRef.current?.value ?? title;
    const bodyNow = incomingBody ?? mention.editorRef.current?.innerText ?? content;
    if (!titleNow.trim() && !bodyNow.trim()) return;
    setMode('text');
  };

  // Voice = DICTATION ONLY (useVoiceTranscribe): the transcript appends to the END of the body
  // (the real modal's own append, EditorialTextModal :434-436) and auto-switches to Text —
  // programmatic writes never fire input (#26), so autoTextMode is called explicitly.
  const voice = useVoiceTranscribe({
    onTranscript: (text) => {
      const next = contentRef.current ? `${contentRef.current}\n${text}` : text;
      setContent(next);
      autoTextMode(next);
    },
    onError: (message) => showToast(message),
  });

  // R11/D19: a live dictation never outlives the Create tab. Leaving Create (Drops, Search,
  // or the post-Create auto-switch) cancels silently — the audio is discarded, nothing is
  // appended — and so does the page going hidden (backgrounded, screen locked, browser tab
  // switched). Staying on Create (editor sheet, canvas, uploads) never cancels. The
  // latest-ref mirror follows the file's contentRef idiom.
  const cancelVoiceRef = useRef(voice.cancel);
  cancelVoiceRef.current = voice.cancel;
  useEffect(() => {
    if (!active) cancelVoiceRef.current();
  }, [active]);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) cancelVoiceRef.current();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Phone BACK exits the full-screen panel while it's open (the fail-safe registry stack —
  // popstate closes the TOP registration only). The view is keep-mounted, so per the hook's
  // own docstring the real open flag (`editorExpanded`) is passed, not a constant true.
  // Every sheet exit (✕, backdrop, phone back, drag-down close) routes through ONE closer so
  // the sheet always re-opens at mid (the approved demo resets its fraction on close).
  const closeEditorSheet = () => {
    setEditorExpanded(false);
    setSheetFull(false);
    setSheetDragH(null);
  };
  useModalBackClose(editorExpanded, closeEditorSheet);

  // Auto-focus the panel's editor once it mounts (the rAF defers focus until the panel
  // exists; no scroll-jumping).
  useEffect(() => {
    if (!editorExpanded) return;
    const raf = requestAnimationFrame(() => mention.focusEditor());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorExpanded]);

  // Object URLs: revoke on replace, on remove — and on unmount (the view only unmounts with
  // the shell; the deps eslint suppression is the point: cleanup reads the FINAL url).
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearPhoto = () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoFile(null);
    setPhotoUrl(null);
  };

  // Every creation event (successful Create tap, or a File-mode attach with ≥1 success —
  // OWNER REQUEST #6) wipes the composer AND every setting back to defaults: title, body (the
  // editor's DOM too — state alone leaves the rendered chips), categories, drawing, photo,
  // mode, reminder (all four hook fields — a stale custom value must never resurface) and
  // lock (plus the R10 card stretch back to 84px). `expiration` is deliberately NOT touched — it survives creation events; only a real
  // page load resets it (no storage).
  const clearDraft = () => {
    setTitle('');
    setContent('');
    if (mention.editorRef.current) mention.editorRef.current.innerHTML = '';
    setSelectedCategories([]);
    setShowCustomInput(false);
    setCustomCategoryName('');
    setDrawingFile(null);
    setInitialScene(null);
    setHasDrawn(false);
    clearPhoto();
    setMode('file');
    setReminderEnabled(false);
    setReminderPreset('15m');
    setReminderCustomValue('');
    setReminderCustomUnit('minutes');
    setLocked(false);
    setBodyH(84); // R6 rider: a creation event also resets the card stretch (OWNER REQUEST #10)
  };

  // ---- R10 drag-resize (OWNER REQUEST #10) — the two approved demos' exact math ----
  const CARD_MIN_H = 84;
  const maxBodyH = () => Math.round(window.innerHeight * 0.55);

  // Card grabber: free stretch between 84px and the cap; on release, snap-assist at the
  // extremes (fling up / near-cap → cap; fling down / near-min → 84px); a gentle mid release
  // STAYS where released. Velocity = px/ms (+down/−up), as in demo-card-stretch.html.
  const cardDrag = useRef({ dragging: false, startY: 0, startH: 0, lastY: 0, lastT: 0, vel: 0 });
  const onCardGrabDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const startH = Math.min(bodyH, maxBodyH());
    cardDrag.current = { dragging: true, startY: e.clientY, startH, lastY: e.clientY, lastT: performance.now(), vel: 0 };
    setBodyH(startH);
    setCardStretching(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onCardGrabMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = cardDrag.current;
    if (!d.dragging) return;
    const now = performance.now();
    d.vel = (e.clientY - d.lastY) / Math.max(1, now - d.lastT);
    d.lastY = e.clientY;
    d.lastT = now;
    setBodyH(Math.round(Math.min(maxBodyH(), Math.max(CARD_MIN_H, d.startH - (e.clientY - d.startY)))));
  };
  const onCardGrabEnd = () => {
    const d = cardDrag.current;
    if (!d.dragging) return;
    d.dragging = false;
    setCardStretching(false);
    const cap = maxBodyH();
    if (d.vel < -0.6 || bodyH > cap - 24) setBodyH(cap);
    else if (d.vel > 0.6 || bodyH < CARD_MIN_H + 24) setBodyH(CARD_MIN_H);
  };

  // Sheet handle: up past ~80% (or flung up) snaps FULL, down to mid; a hard fling down from
  // mid, or a slow drag releasing below ~50%, CLOSES — demo-panel-resize.html's exact math.
  const SHEET_MID = 0.6;
  const sheetPanelRef = useRef<HTMLDivElement | null>(null);
  const sheetDrag = useRef({ dragging: false, startY: 0, startH: 0, lastY: 0, lastT: 0, vel: 0 });
  const onSheetHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const startH = sheetPanelRef.current?.getBoundingClientRect().height ?? window.innerHeight * SHEET_MID;
    sheetDrag.current = { dragging: true, startY: e.clientY, startH, lastY: e.clientY, lastT: performance.now(), vel: 0 };
    setSheetDragH(startH); // switch the panel to live px for the gesture
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onSheetHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sheetDrag.current;
    if (!d.dragging) return;
    const now = performance.now();
    d.vel = (e.clientY - d.lastY) / Math.max(1, now - d.lastT);
    d.lastY = e.clientY;
    d.lastT = now;
    const min = window.innerHeight * 0.35;
    setSheetDragH(Math.round(Math.min(window.innerHeight, Math.max(min, d.startH - (e.clientY - d.startY)))));
  };
  const onSheetHandleEnd = () => {
    const d = sheetDrag.current;
    if (!d.dragging) return;
    d.dragging = false;
    const f = (sheetDragH ?? d.startH) / window.innerHeight;
    if (d.vel < -0.6 || f > 0.8) setSheetFull(true);
    else if (d.vel > 0.6 && f < 0.72) closeEditorSheet();
    else if (f >= 0.5) setSheetFull(false);
    else closeEditorSheet();
    setSheetDragH(null); // back to the dvh snap target — the 0.25s height transition animates it
  };

  // A pending lock must never leak into the new space (the prototype's "lock resets on
  // leaving"); everything else in the draft survives the switch.
  useEffect(() => {
    setLocked(false);
  }, [currentWorkspaceId]);

  // Re-extract the Excalidraw scene whenever the canvas opens with a sketch attached (the
  // modal's edit-extraction port, EditorialTextModal :147-172). Failures are non-fatal —
  // the canvas just opens blank.
  useEffect(() => {
    if (!drawOpen || !drawingFile) return;
    let cancelled = false;
    const url = URL.createObjectURL(drawingFile);
    setExtractingScene(true);
    fetch(url)
      .then((res) => res.blob())
      .then(async (blob) => {
        const { loadFromBlob } = await import('@excalidraw/excalidraw');
        const scene = await loadFromBlob(blob, null, null);
        if (!cancelled) {
          setInitialScene({ elements: [...scene.elements], appState: scene.appState, files: scene.files || undefined });
          if (scene.appState?.viewBackgroundColor) {
            setBgColor(scene.appState.viewBackgroundColor);
          }
          setExtractingScene(false);
        }
      })
      .catch((err) => {
        console.warn('No scene data in drawing:', err);
        if (!cancelled) setExtractingScene(false);
      });
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [drawOpen, drawingFile]);

  // Two-phase draw (the modal's own flow): saving the drawing is NOT saving the drop — it
  // attaches the sketch and returns to the form. Opened-and-unchanged (nothing drawn, nothing
  // attached) just closes (prototype :1487).
  const handleDrawingSave = (file: File) => {
    const replacing = !!drawingFile;
    if (!hasDrawn && !drawingFile) {
      setDrawOpen(false);
      return;
    }
    setDrawingFile(file);
    setHasDrawn(false);
    setDrawOpen(false);
    showToast(replacing ? 'Drawing updated — the drop is created with Create' : 'Drawing attached — the drop is created with Create');
  };

  const removeDrawing = () => {
    setDrawingFile(null);
    setInitialScene(null);
    setHasDrawn(false);
    showToast('Drawing removed from this drop');
  };

  // Start-from chip tap (prototype pickStart :1344-1352): leaving Text clears a pending photo;
  // Draw opens the canvas; Text focuses the composer. Blocked while an upload runs (OWNER
  // REQUEST #6 — the in-flight attach owns the flow until it finalizes).
  const pickStart = (kind: StartMode) => {
    if (uploading) return;
    if (kind !== 'text' && mode === 'text' && photoFile) {
      clearPhoto();
      showToast('Pending photo cleared — photos ride with Text');
    }
    setMode(kind);
    if (kind === 'draw') setDrawOpen(true);
    else if (kind === 'text') mention.focusEditor();
  };

  // Strip tap: in Draw mode the drawing owns the image slot — the tap opens the switch popup
  // instead of the file picker (prototype stripTap :1541).
  const handleStripTap = () => {
    if (mode === 'draw') {
      setSwitchSheet(true);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;
    if (mode === 'draw') {
      setSwitchSheet(true);
      return;
    }
    if (mode === 'text') {
      // Text mode carries ONE image — replace-on-re-pick; everything else is refused.
      const file = files[0];
      if (!file.type.startsWith('image/')) {
        showToast('Text drops carry one image — switch to File for that');
        return;
      }
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      setPhotoFile(file);
      setPhotoUrl(URL.createObjectURL(file));
      showToast('Photo attached — rides with Create');
      return;
    }
    // File mode — every pick births its own drop instantly with the form's expiry/lock (the
    // DropZone's sequential loop, EditorialDropZone :100-169). No refresh: the live Firestore
    // subscription updates the shell's drops. The busy-guard blocks a concurrent run
    // (DropZone :104). Failures collect into ONE joined toast and stay on Create — no reset,
    // no switch (a switch would hide the error). A clean run finalizes exactly like Create:
    // full reset + the shell's switch to the Drops tab, with NO success toasts (OWNER
    // REQUEST #6 — silence IS the design; the new drops are the feedback).
    if (!user || uploading) return;
    setUploading(true);
    const creatorName = user.displayName || user.email?.split('@')[0] || undefined;
    const failed: { name: string; message: string }[] = [];
    setUploadProgress({ completed: 0, total: files.length });
    try {
      for (const file of files) {
        try {
          const result = await createFileDrop(user.uid, file, expiration, currentWorkspaceId, workspaceMembers, creatorName, locked);
          if (result.error) {
            failed.push({ name: file.name, message: result.error });
          }
        } catch {
          failed.push({ name: file.name, message: 'Failed to upload file. Please try again.' });
        }
        setUploadProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev));
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
    if (failed.length > 0) {
      showToast(failed.map((f) => `${f.name}: ${f.message}`).join('; '));
      return; // stay on Create — a switch would hide the error (OWNER REQUEST #6.4)
    }
    clearDraft(); // full reset, expiry untouched
    onCreated();  // shell → the Drops tab, exactly like Create (OWNER REQUEST #6.2)
  };

  // The "# drop chip" button (locked design furniture): inserts a literal # at the caret —
  // the REAL #-autocomplete dropdown opens from the fired input (ruling §3.1).
  const insertHashChip = () => {
    mention.focusEditor();
    document.execCommand('insertText', false, '#');
    autoTextMode();
  };

  // Create submit — the real funnel (createTextDrop; EditorialTextModal :286 truth).
  const handleCreate = async () => {
    if (creating) return;
    if (!content.trim() && !drawingFile) return; // modal :245 — the button is disabled anyway
    if (reminderEnabled && reminderInvalidValue) return; // modal :248
    if (!user) return;
    setCreating(true);
    try {
      const creatorName = user.displayName || user.email?.split('@')[0] || undefined;
      const drop = await createTextDrop(
        user.uid,
        title.trim() || 'Text snippet',
        content,
        expiration,
        currentWorkspaceId,
        workspaceMembers,
        selectedCategories[0] || undefined,
        creatorName,
        drawingFile || photoFile || undefined,
        selectedCategories,
        !!drawingFile,
        currentWorkspace ? locked : false,
        reminderEnabled && !reminderInvalidValue ? reminderAtValue : null
      );
      if (!drop) {
        showToast('Failed to create text drop. Please try again.');
        return;
      }
      clearDraft(); // prototype :1522-1526
      onCreated(); // shell → setActiveTab('drops') (prototype :1527)
    } catch {
      showToast('Failed to create text drop. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  // Custom category (port of EditorialTextModal :305-323): persisted via onCreateCategory,
  // selected on success (room permitting).
  const handleCreateCustomCategory = async () => {
    if (!customCategoryName.trim()) return;
    setCreatingCategory(true);
    try {
      const newCategory = await onCreateCategory(customCategoryName.trim());
      if (newCategory) {
        if (selectedCategories.length < 3) {
          setSelectedCategories((prev) => [...prev, newCategory]);
        }
        setShowCustomInput(false);
        setCustomCategoryName('');
      }
    } catch (error) {
      console.error('Error creating category:', error);
    }
    setCreatingCategory(false);
  };

  const trimmedCategoryLower = customCategoryName.trim().toLowerCase();
  const isDuplicateCategoryName =
    trimmedCategoryLower !== '' &&
    (categories.some((c) => c.name.trim().toLowerCase() === trimmedCategoryLower) ||
      BUILT_IN_CATEGORIES.some((b) => b.value === trimmedCategoryLower));

  // Category pill toggle with the max-3 gate (port of the modal's toggleCategory, :224-230).
  const toggleCategorySelect = (cat: string) => {
    setSelectedCategories((prev) => {
      if (prev.includes(cat)) return prev.filter((c) => c !== cat);
      if (prev.length >= 3) return prev;
      return [...prev, cat];
    });
  };

  // Mode-driven attach-strip copy (prototype syncStrip :1542-1546).
  const stripCopy =
    mode === 'text'
      ? { title: 'Attach images', sub: 'One photo · rides with Create', aria: 'Attach images' }
      : mode === 'draw'
        ? { title: 'Attach files', sub: 'A drawing owns the image slot — tap to switch', aria: 'Attachments unavailable while drawing' }
        : { title: 'Attach files', sub: 'Photos, video, audio · 500MB max', aria: 'Attach files' };
  // While a File-mode upload runs the strip goes busy (spinner + "Uploading… · N/M").
  const stripBusy = uploading;

  const categoryNames = dedupeCategoryNames(categories.map((c) => c.name));

  // Shared pill face (the modal's pill classes; active = ink-inverted).
  const pillBase = `px-3 py-1.5 text-xs rounded-full border transition-colors ${font}`;
  const pillOn = `${pillBase} ${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`;
  const pillOff = `${pillBase} ${tc.border} ${tc.text} hover:border-[#1a1a1a]`;

  // The composer's editor body — ONE JSX value (dropdown + placeholder + editor) so the same
  // markup renders at exactly ONE mount point at a time: the card's state-driven field (84px ↔
  // the R10 stretch cap), or the resizable sheet's h-full field (mid ~60dvh / full) (R7; the
  // sizing class keys off the same editorExpanded flag that picks the mount). The ref is the
  // hook's CALLBACK ref (setEditorRef,
  // useMentionEditor :178-196): it mirrors the node into the stable editorRef AND bumps
  // mountKey, so the external→DOM sync effect re-runs on every remount and re-renders the
  // chips from `content` even when unchanged — the content-integrity guarantee for the
  // card↔panel swap (the plain editorRef would leave a remounted editor blank).
  const editorBody = (
    <>
      {/* #-mention dropdown — floats just above the editor (modal :883-899 port) */}
      {mention.showMention && mention.filteredMentionDrops.length > 0 && (
        <div
          ref={mention.dropdownRef}
          className={`absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto rounded-md border ${tc.border} ${tc.bg} shadow-lg`}
        >
          {mention.filteredMentionDrops.map((drop, idx) => (
            <EditorialDropPickerRow
              key={drop.id}
              drop={drop}
              selected={idx === mention.mentionIndex}
              attached={false}
              onSelect={mention.insertMention}
              theme={theme}
            />
          ))}
        </div>
      )}
      {content === '' && !mention.showMention && (
        <span className={`pointer-events-none absolute left-0 top-0 text-sm ${font} ${theme === 'dark' ? 'text-white/30' : 'text-[#1A1A1A]/30'}`}>
          Write something… markdown works. Type # to mention a drop.
        </span>
      )}
      <div
        ref={mention.setEditorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={() => {
          mention.handleInput();
          autoTextMode();
        }}
        onKeyDown={mention.handleKeyDown}
        onBlur={mention.handleBlur}
        role="textbox"
        aria-multiline="true"
        aria-label="Drop body"
        className={`w-full border-none bg-transparent px-0 py-0 text-[13px] leading-relaxed focus:outline-none ${font} ${tc.text} ${editorExpanded ? 'h-full' : ''} overflow-y-auto whitespace-pre-wrap break-words`}
        style={editorExpanded ? undefined : {
          height: `${bodyH}px`,
          transition: cardStretching ? 'none' : 'height 0.25s cubic-bezier(0.4,0,0.2,1)',
        }}
      />
    </>
  );

  return (
    <div className="h-full space-y-4 overflow-y-auto overscroll-contain px-4 pb-28 editorial-scroll-hide">
      {/* Title block (prototype :517) — the Drops h1 idiom; NO top padding (D12: the header's
          own space is the gap) */}
      <div>
        <h1 className={`text-[26px] font-semibold leading-[1.15] tracking-[-0.5px] ${font} ${tc.text}`}>Create a drop</h1>
        <p className={`mt-[3px] text-xs ${font} ${tc.muted}`}>Everything expires on your schedule</p>
      </div>

      {/* Attach strip (prototype :519-526) — mode-driven copy; dimmed + popup in Draw mode.
          While an upload runs: disabled, aria-busy, spinner + "Uploading… · N/M" (OWNER
          REQUEST #6). */}
      <button
        type="button"
        onClick={handleStripTap}
        disabled={uploading}
        aria-busy={uploading}
        aria-label={stripCopy.aria}
        className={`flex w-full items-center gap-3 rounded-[14px] border px-4 py-3.5 text-left transition-opacity ${tc.cardBg} ${tc.border} ${mode === 'draw' ? 'opacity-40' : stripBusy ? 'opacity-60' : ''}`}
      >
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${tc.border} ${tc.muted}`}>
          {stripBusy ? (
            <div className="h-4 w-4 animate-spin rounded-full border border-current/30 border-t-current" />
          ) : (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5.5v13M5.5 12h13" />
            </svg>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${font} ${tc.text}`}>
            {stripBusy
              ? `Uploading…${uploadProgress && uploadProgress.total > 1 ? ` · ${uploadProgress.completed}/${uploadProgress.total}` : ''}`
              : stripCopy.title}
          </span>
          <span className={`mt-0.5 block truncate text-xs ${font} ${tc.muted}`}>{stripCopy.sub}</span>
        </span>
        <span className={`shrink-0 text-xs font-medium ${font} ${tc.text}`}>Browse</span>
      </button>
      {/* One hidden input, keyed by mode so a mode switch resets it cleanly; value reset after
          every pick (the DropZone's pattern, EditorialDropZone :198-200) */}
      <input
        key={mode}
        ref={fileInputRef}
        type="file"
        hidden
        multiple={mode === 'file'}
        accept={mode === 'text' ? 'image/*' : undefined}
        onChange={handleFilePick}
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Photo row (Text mode only, prototype :528-535) */}
      {mode === 'text' && photoFile && photoUrl && (
        <div className="flex flex-col gap-1.5">
          <div className={`flex items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-3 ${tc.border}`}>
            <img src={photoUrl} alt={photoFile.name} className="h-8 w-8 shrink-0 rounded-full object-cover" />
            <span className={`min-w-0 flex-1 truncate text-xs ${font} ${tc.text}`}>{photoFile.name}</span>
            <button
              type="button"
              onClick={clearPhoto}
              aria-label="Remove photo"
              className={`shrink-0 ${tc.muted} transition-colors hover:text-red-500`}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
                <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <span className={`text-[10.5px] ${font} ${tc.muted}`}>Rides with Create · one photo max</span>
        </div>
      )}

      {/* Start-from chips (prototype :537-541) — File is the default; Draw carries the attached
          state (check glyph, :1502-1508) with a ✕ to remove the sketch */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => pickStart('file')}
          disabled={uploading}
          aria-pressed={mode === 'file'}
          className={`disabled:opacity-30 disabled:cursor-not-allowed ${mode === 'file' ? pillOn : pillOff}`}
        >
          <span className="flex items-center gap-1.5">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-5.5-5.5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 3.5V9H19" />
            </svg>
            File
          </span>
        </button>
        <button
          type="button"
          onClick={() => pickStart('text')}
          disabled={uploading}
          aria-pressed={mode === 'text'}
          className={`disabled:opacity-30 disabled:cursor-not-allowed ${mode === 'text' ? pillOn : pillOff}`}
        >
          <span className="flex items-center gap-1.5">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 3.5 20.5 7 8.5 19l-4.6 1.1L5 15.5 17 3.5z" />
            </svg>
            Text
          </span>
        </button>
        {drawingFile ? (
          <>
            <button
              type="button"
              onClick={() => setDrawOpen(true)}
              aria-pressed
              aria-label="Drawing attached — tap to edit"
              className={pillOn}
            >
              <span className="flex items-center gap-1.5">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.4}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m5.5 12.5 4 4 9-9.5" />
                </svg>
                Drawing attached
              </span>
            </button>
            <button
              type="button"
              onClick={removeDrawing}
              aria-label="Remove drawing"
              className={`flex h-7 w-7 items-center justify-center rounded-full border ${tc.border} ${tc.muted} transition-colors hover:text-red-500`}
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
                <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => pickStart('draw')}
            disabled={uploading}
            aria-pressed={mode === 'draw'}
            className={`disabled:opacity-30 disabled:cursor-not-allowed ${mode === 'draw' ? pillOn : pillOff}`}
          >
            <span className="flex items-center gap-1.5">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 21c3-1 5-2.5 8-6l7.5-7.5a2.1 2.1 0 0 0-3-3L8 12c-3.5 3-5 5-5 9z" />
              </svg>
              Draw
            </span>
          </button>
        )}
      </div>

      {/* Composer card (prototype :544-554) — the body is the REAL mention editor (ruling §3.1).
          ONE card, borderless fields inside (D18, prototype :213-217): the card's own border
          darkens on focus-within (:61), title 14.5px/600/−0.1px, body 13px/1.55 in a fixed
          84px internally-scrolling field, divider ~10px around, title→body 8px (explicit
          margins, not space-y, to hit the prototype's exact gaps). */}
      <div className={`relative rounded-[14px] border p-3.5 transition-colors ${tc.cardBg} ${tc.border} ${theme === 'dark' ? 'focus-within:border-white/70' : 'focus-within:border-[#1A1A1A]'}`}>
        <div className="flex items-center gap-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              autoTextMode();
            }}
            placeholder="Title"
            aria-label="Drop title"
            className={`w-full flex-1 min-w-0 bg-transparent text-[14.5px] font-semibold tracking-[-0.1px] ${font} ${tc.text} focus:outline-none`}
          />
          <button
            type="button"
            onClick={() => setEditorExpanded(true)}
            aria-label="Expand editor"
            title="Expand editor"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${tc.border} ${tc.muted} transition-colors hover:border-[#1a1a1a] hover:${tc.text}`}
          >
            {/* the desktop modal's ENTER glyph (EditorialTextModal :506-508), verbatim */}
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m-4.5-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          </button>
        </div>
        {/* R8: a thin hairline between the title and the body field (8px above, 8px below) */}
        <div className={`mt-2 border-t ${tc.border}`} />
        {!editorExpanded && (
          <div className="relative mt-2">{editorBody}</div>
        )}
        <div className={`mt-2.5 border-t ${tc.border}`} />
        <div className="mt-2.5 flex items-center justify-between">
          <button
            type="button"
            onClick={insertHashChip}
            aria-label="Insert a drop mention"
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${font} ${tc.border} ${tc.text} hover:border-[#1a1a1a]`}
          >
            # drop chip
          </button>
          {/* Recording = the prototype's .mic-btn.rec exactly (prototype :221-222): ink-inverted
              circle (--danger = the ink token) with an expanding ring ping — motion boxShadow
              0 → 9px transparent, 1.6s, infinite (component-scoped; NOT Tailwind animate-pulse). */}
          <motion.button
            type="button"
            onClick={() => voice.toggle()}
            disabled={voice.isTranscribing}
            aria-label={voice.isRecording ? 'Stop dictation' : voice.isTranscribing ? 'Transcribing…' : 'Voice dictation'}
            className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
              voice.isRecording
                ? `${tc.activePillBg} ${tc.activePillText} border-transparent`
                : voice.isTranscribing
                  ? `${tc.border} ${tc.muted} opacity-50 cursor-wait`
                  : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
            }`}
            animate={voice.isRecording
              ? { boxShadow: [
                  `0 0 0 0px ${theme === 'dark' ? 'rgba(255,255,255,0.35)' : 'rgba(26,26,26,0.35)'}`,
                  `0 0 0 9px ${theme === 'dark' ? 'rgba(255,255,255,0)' : 'rgba(26,26,26,0)'}`,
                ] }
              : { boxShadow: '0 0 0 0px rgba(0,0,0,0)' }}
            transition={voice.isRecording ? { duration: 1.6, repeat: Infinity, ease: 'linear' } : { duration: 0.15 }}
          >
            {voice.isTranscribing ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border border-current/30 border-t-current" />
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 2.5h6v11a3 3 0 0 1-3 3 3 3 0 0 1-3-3v-11z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 11a7 7 0 0 0 14 0M12 18v3.5" />
              </svg>
            )}
          </motion.button>
        </div>
        {/* R10 card grabber — straddles the card's bottom edge; drag stretches the body in
            place (84px ↔ ~55% of the viewport) while the tools row stays usable
            (demo-card-stretch.html). Renders only while the sheet is closed. */}
        {!editorExpanded && (
          <div
            role="separator"
            aria-label="Drag to stretch the editor"
            className="absolute bottom-[-12px] left-1/2 z-10 flex h-6 w-20 -translate-x-1/2 cursor-grab items-center justify-center active:cursor-grabbing"
            style={{ touchAction: 'none' }}
            onPointerDown={onCardGrabDown}
            onPointerMove={onCardGrabMove}
            onPointerUp={onCardGrabEnd}
            onPointerCancel={onCardGrabEnd}
          >
            <div className="h-1.5 w-11 rounded-full bg-current opacity-20" />
          </div>
        )}
      </div>

      {/* Expires (prototype :556-563) — short pills, 2h default; Forever gated by the REAL
          ForeverLockedModal for standard tier (ruling §3.2) */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>Expires</span>
          <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>{expiration}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {EXPIRY_PILLS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={expiration === option.value}
              onClick={() => {
                if (option.value === 'forever' && tier === 'standard' && !tierLoading) {
                  setShowForeverLocked(true);
                  return;
                }
                setExpiration(option.value);
              }}
              className={expiration === option.value ? pillOn : pillOff}
            >
              {option.value === 'forever' ? (
                <span className="flex items-center gap-1">
                  Forever
                  <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
                  </svg>
                </span>
              ) : (
                option.label
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Categories (prototype :569-584; port of the modal's :573-661) — LIVE counter, max-3
          disable, ＋ chip → the persisted custom flow (onCreateCategory) */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>Categories</span>
          <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>{selectedCategories.length} / 3</span>
        </div>
        {!showCustomInput ? (
          <div className="flex flex-wrap gap-2">
            {BUILT_IN_CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                aria-pressed={selectedCategories.includes(cat.value)}
                onClick={() => toggleCategorySelect(cat.value)}
                disabled={!selectedCategories.includes(cat.value) && selectedCategories.length >= 3}
                className={`disabled:opacity-30 disabled:cursor-not-allowed ${selectedCategories.includes(cat.value) ? pillOn : pillOff}`}
              >
                {cat.label}
              </button>
            ))}
            {categoryNames.map((cat) => (
              <button
                key={cat}
                type="button"
                aria-pressed={selectedCategories.includes(cat)}
                onClick={() => toggleCategorySelect(cat)}
                disabled={!selectedCategories.includes(cat) && selectedCategories.length >= 3}
                className={`disabled:opacity-30 disabled:cursor-not-allowed ${selectedCategories.includes(cat) ? pillOn : pillOff}`}
              >
                {cat}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowCustomInput(true)}
              aria-label="Add custom category"
              className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors`}
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" d="M12 5.5v13M5.5 12h13" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customCategoryName}
                onChange={(e) => setCustomCategoryName(e.target.value)}
                placeholder="Category name"
                aria-label="New category name"
                autoFocus
                className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:border-[#1a1a1a] transition-colors ${font} ${tc.border} ${tc.bg} ${tc.text}`}
              />
              <button
                type="button"
                onClick={handleCreateCustomCategory}
                disabled={!customCategoryName.trim() || creatingCategory || isDuplicateCategoryName}
                className={`shrink-0 px-3 py-2 text-xs rounded-full hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity ${font} ${tc.activePillBg} ${tc.activePillText}`}
              >
                {creatingCategory ? '...' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCustomInput(false);
                  setCustomCategoryName('');
                }}
                aria-label="Cancel new category"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${tc.border} ${tc.text} transition-colors hover:border-[#1a1a1a]`}
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            {isDuplicateCategoryName && !creatingCategory && (
              <p className={`text-xs text-red-500 ${font}`}>Category already exists</p>
            )}
          </div>
        )}
      </div>

      {/* Reminder (prototype :586-608; port of the modal's :1080-1153) — lowercase preset face
          per the prototype; the live note is the hook's own warning / fire preview. A reminder
          never rides a File-mode instant drop (createFileDrop takes no reminder). */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>Reminder</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={reminderEnabled}
            aria-label={reminderEnabled ? 'Reminder on' : 'Reminder off'}
            onClick={() => setReminderEnabled(!reminderEnabled)}
            className={reminderEnabled ? pillOn : pillOff}
          >
            <span className="flex items-center gap-1.5">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.3 19a2 2 0 0 0 3.4 0" />
              </svg>
              {reminderEnabled ? 'On' : 'Off'}
            </span>
          </button>
          {reminderEnabled && (
            <>
              {REMINDER_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={pickerActive && reminderPreset === p}
                  onClick={() => setReminderPreset(p)}
                  className={pickerActive && reminderPreset === p ? pillOn : pillOff}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={pickerActive && reminderPreset === 'custom'}
                onClick={() => setReminderPreset('custom')}
                className={pickerActive && reminderPreset === 'custom' ? pillOn : pillOff}
              >
                Custom
              </button>
              {reminderPreset === 'custom' && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={reminderCustomValue}
                    onChange={(e) => setReminderCustomValue(e.target.value)}
                    placeholder="0"
                    aria-label="Custom reminder value"
                    className={`w-16 rounded-lg border px-3 py-2 text-sm focus:outline-none ${font} ${tc.border} ${tc.bg} ${tc.text}`}
                  />
                  <select
                    value={reminderCustomUnit}
                    onChange={(e) => setReminderCustomUnit(e.target.value as ReminderUnit)}
                    aria-label="Custom reminder unit"
                    className={`rounded-lg border px-2 py-2 text-sm focus:outline-none ${font} ${tc.border} ${tc.bg} ${tc.text}`}
                  >
                    <option value="minutes">min</option>
                    <option value="hours">hr</option>
                    <option value="days">day</option>
                  </select>
                  <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>before expiry</span>
                </div>
              )}
            </>
          )}
        </div>
        {reminderFire?.fired ? (
          <p className={`mt-1 text-xs text-red-500 ${font}`}>This reminder has fired — pick a new time to re-arm, or turn it off.</p>
        ) : reminderWarningValue ? (
          <p className={`mt-1 text-xs text-red-500 ${font}`}>{reminderWarningValue}</p>
        ) : reminderFire && !reminderFire.fired ? (
          <p className={`mt-1 text-xs ${font} ${tc.muted}`}>
            Fires {reminderFire.absolute}{reminderFire.remaining ? ` · ${reminderFire.remaining}` : ''}
          </p>
        ) : null}
      </div>

      {/* Access (prototype :610-621) — the ONE-pill face, shared workspaces only (personal
          drops never show lock UI, D13 parity; locked is forced false at submit too) */}
      {currentWorkspace && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>Access</span>
            <span className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>{currentWorkspace.name}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={locked}
              aria-label={locked ? 'Locked — only you can edit this drop' : 'Open — anyone can edit'}
              onClick={() => setLocked(!locked)}
              className={locked ? pillOn : pillOff}
            >
              <span className="flex items-center gap-1.5">
                {locked ? (
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm10-10V7a4 4 0 0 0-8 0v4h8z" />
                  </svg>
                ) : (
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 1 1 8 0m-4 8v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2z" />
                  </svg>
                )}
                {locked ? 'Locked — only you can edit this drop' : 'Open — anyone can edit'}
              </span>
            </button>
          </div>
          {locked && (
            <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${font} ${tc.muted}`}>
              <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
              </svg>
              Locked — only you can edit this drop. Everyone else gets read-only.
            </p>
          )}
        </div>
      )}

      {/* CTA (prototype :623) — modal :1168 truth: a photo alone cannot create */}
      <button
        type="button"
        onClick={handleCreate}
        disabled={creating || uploading || (!content.trim() && !drawingFile) || (reminderEnabled && reminderInvalidValue)}
        className={`flex w-full items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ${font} ${tc.activePillBg} ${tc.activePillText}`}
      >
        {creating ? (
          <>
            <div className="h-4 w-4 animate-spin rounded-full border border-white/30 border-t-white" />
            Creating…
          </>
        ) : (
          'Create'
        )}
      </button>

      {/* Draw-mode switch popup (prototype :787-796) — the folder's bottom-sheet idiom
          (keyed conditional children inside one AnimatePresence, MobileSortMenu pattern) */}
      <AnimatePresence>
        {switchSheet && (
          <motion.div
            key="switch-backdrop"
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setSwitchSheet(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
        {switchSheet && (
          <motion.div
            key="switch-panel"
            role="dialog"
            aria-label="Drawings own the image slot"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
            className={`fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] border-t px-5 pt-4 pb-[calc(20px+env(safe-area-inset-bottom))] ${tc.cardBg} ${tc.border}`}
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-current opacity-20" />
            <p className={`text-sm font-semibold ${font} ${tc.text}`}>Drawings own the image slot</p>
            <p className={`mt-1 text-xs leading-relaxed ${font} ${tc.muted}`}>
              A drawing drop can&apos;t carry photos or files. Where would you like to attach instead?
            </p>
            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setSwitchSheet(false);
                  pickStart('text');
                }}
                className={`flex-1 rounded-full border py-2.5 text-sm transition-colors ${font} ${tc.border} ${tc.text} hover:border-[#1a1a1a]`}
              >
                Switch to Text
              </button>
              <button
                type="button"
                onClick={() => {
                  setSwitchSheet(false);
                  pickStart('file');
                }}
                className={`flex-1 rounded-full py-2.5 text-sm transition-opacity hover:opacity-90 ${font} ${tc.activePillBg} ${tc.activePillText}`}
              >
                Switch to File
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen editor panel (R7) — the desktop modal's own mechanism (EditorialTextModal
          :878-914) in the folder's sheet idiom at full height: backdrop click-outside (:879),
          slim header row with the EXIT glyph (:905-914), the same editor body filling the rest
          (h-full min-h-0, :924). Open/close both animate; phone BACK exits via useModalBackClose.
          While open, the card renders no second editor copy — one mount, content intact. */}
      <AnimatePresence>
        {editorExpanded && (
          <motion.div
            key="editor-backdrop"
            className="fixed inset-0 z-[60] bg-black/50"
            onClick={(e) => e.target === e.currentTarget && closeEditorSheet()}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
        {editorExpanded && (
          <motion.div
            key="editor-panel"
            ref={sheetPanelRef}
            role="dialog"
            aria-label={sheetFull ? 'Full-screen editor' : 'Expanded editor'}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
            className={`fixed inset-x-0 bottom-0 z-[60] flex flex-col ${tc.bg} pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${sheetFull ? '' : 'rounded-t-[14px]'}`}
            style={{
              height: sheetDragH != null ? `${sheetDragH}px` : sheetFull ? '100dvh' : '60dvh',
              transition: sheetDragH != null ? 'none' : 'height 0.25s cubic-bezier(0.4,0,0.2,1)',
            }}
          >
            <div className={`flex items-center justify-end px-3 py-2 border-b ${tc.border}`}>
              <button
                type="button"
                onClick={() => closeEditorSheet()}
                aria-label="Exit full screen"
                title="Exit full screen"
                className={`flex h-8 w-8 items-center justify-center rounded-full border ${tc.border} ${tc.text} transition-colors hover:border-[#1a1a1a]`}
              >
                {/* the desktop modal's EXIT glyph (EditorialTextModal :502-504), verbatim */}
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              </button>
            </div>
            <div className="flex flex-1 flex-col px-4 py-3 min-h-0">
              <div className="relative flex-1 min-h-0">{editorBody}</div>
            </div>
            {/* R10 sheet handle — drag up → full, down → mid, hard/far down → close
                (demo-panel-resize.html); ✕ / backdrop / phone back close unchanged. */}
            <div
              role="separator"
              aria-label="Drag to resize the editor"
              className="flex h-7 flex-none cursor-grab items-center justify-center active:cursor-grabbing"
              style={{ touchAction: 'none' }}
              onPointerDown={onSheetHandleDown}
              onPointerMove={onSheetHandleMove}
              onPointerUp={onSheetHandleEnd}
              onPointerCancel={onSheetHandleEnd}
            >
              <div className="h-1 w-9 rounded-full bg-current opacity-20" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The REAL canvas (ruling §3.3) — always fullscreen on mobile; the header row carries the
          title + the Background dots (modal :736-756 port). The canvas mounts only after scene
          extraction (Excalidraw reads initialData once at mount — the modal gates the same way). */}
      {drawOpen && !extractingScene && (
        <DrawingCanvas
          startFullscreen
          header={
            <div className="flex items-center justify-between gap-3">
              <span className={`shrink-0 text-sm font-medium ${font} ${tc.text}`}>Drawing</span>
              <div className="flex items-center gap-2">
                <span className={`shrink-0 text-xs ${font} ${tc.muted}`}>Background</span>
                <div className="flex gap-1.5">
                  {BG_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setBgColor(c.value)}
                      aria-label={`Background ${c.label}`}
                      title={c.label}
                      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        bgColor === c.value
                          ? `${theme === 'dark' ? 'border-white scale-110' : 'border-[#1A1A1A] scale-110'}`
                          : `${theme === 'dark' ? 'border-white/30' : 'border-[#1a1a1a]/20'}`
                      }`}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>
            </div>
          }
          onSave={handleDrawingSave}
          onCancel={() => setDrawOpen(false)}
          onDraw={() => setHasDrawn(true)}
          theme={theme}
          bgColor={bgColor}
          initialScene={initialScene ?? undefined}
        />
      )}
      {drawOpen && extractingScene && (
        <div className={`fixed inset-0 z-[999] flex items-center justify-center ${theme === 'dark' ? 'bg-[#0D0D0D]' : 'bg-[#FAF7F2]'}`}>
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border border-current/30 border-t-current" />
            <span className={`text-xs ${font} ${tc.muted}`}>Loading drawing...</span>
          </div>
        </div>
      )}

      {/* Forever lock modal (ruling §3.2) — the REAL modal, editorial variant */}
      {showForeverLocked && (
        <ForeverLockedModal context="create" variant="editorial" theme={theme} onClose={() => setShowForeverLocked(false)} />
      )}

      {/* All Create toasts float ABOVE the navbar (prototype :337-342 position, §4.3) */}
      {toast && (
        <Toast
          key={toast.seq}
          message={toast.msg}
          duration={3}
          theme={theme}
          editorial
          mobileFloat
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}
