'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Drop, ExpirationOption } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { useUserTier } from '@/hooks/useUserTier';
import { getEditorialThemeColors } from './editorialTheme';
import { ForeverLockedModal } from '../ForeverLockedModal';
import { decryptDrop } from '@/lib/drops';
import { DrawingCanvas, BG_COLORS } from '../DrawingCanvas';
import { EditorialDropPickerRow } from './EditorialDropPickerRow';
import { useMentionEditor } from '@/hooks/useMentionEditor';

interface EditorialTextModalProps {
  onSubmit: (name: string, content: string, expiration: ExpirationOption, category?: string, imageFile?: File, categories?: string[], isDrawing?: boolean, locked?: boolean) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  editDrop?: Drop | null;
  onEdit?: (drop: Drop, updates: { name?: string; content?: string; category?: string | null; categories?: string[]; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean; locked?: boolean }) => Promise<boolean>;
  currentUserId?: string;
  // Drops in the current space, used for the #-mention autocomplete in the content field.
  mentionableDrops?: Drop[];
  // Whether the create flow is for a shared workspace (the lock toggle is workspace-only).
  isWorkspace?: boolean;
  // Creator/workspace owner — may toggle the lock on an existing workspace drop in edit mode.
  canMutate?: boolean;
}

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '2h', label: '2 hours' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: 'forever', label: 'Forever' },
];

const BUILT_IN_CATEGORIES = [
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

export function EditorialTextModal({ onSubmit, onClose, theme = 'light', customCategories = [], onCreateCategory, editDrop, onEdit, currentUserId, mentionableDrops = [], isWorkspace = false, canMutate = false }: EditorialTextModalProps) {
  useBodyScrollLock();
  useModalBackClose(true, onClose);
  const isEditMode = !!editDrop;
  const isFileDrop = isEditMode && editDrop?.type === 'file';
  // Show the toggle for a new shared-workspace drop, or when editing one as creator/owner
  // (canMutate). Personal drops and non-creator edits never show it.
  const showLockToggle = (!isEditMode && isWorkspace) || (isEditMode && canMutate && !!editDrop?.workspaceId);
  const [name, setName] = useState(editDrop?.name || '');
  const [content, setContent] = useState(editDrop?.content || '');
  const [loading, setLoading] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>(editDrop?.expirationOption || '2h');
  const [showForeverLocked, setShowForeverLocked] = useState(false);
  const [foreverContext, setForeverContext] = useState<'create' | 'edit'>('create');
  // Open/Locked toggle — create mode + shared workspace only. Edit-mode toggling is Phase 4.
  const [locked, setLocked] = useState(false);
  // Edit mode seeds the toggle from the drop being edited; create mode keeps the Open default.
  useEffect(() => {
    if (isEditMode && editDrop) {
      setLocked(editDrop.locked ?? false);
    }
  }, [isEditMode, editDrop]);
  const { tier, loading: tierLoading } = useUserTier();
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    editDrop?.categories || (editDrop?.category ? [editDrop.category] : [])
  );
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCategoryName, setCustomCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);
  const [imageRemoved, setImageRemoved] = useState(false);
  const [decryptingImage, setDecryptingImage] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'text' | 'draw'>(
    isEditMode && editDrop?.isDrawing ? 'draw' : 'text'
  );
  const [bgColor, setBgColor] = useState('#ffffff');
  const [hasDrawn, setHasDrawn] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [initialScene, setInitialScene] = useState<{ elements: any[]; appState: any; files?: any } | null>(null);
  const [extractingScene, setExtractingScene] = useState(isEditMode && !!editDrop?.isDrawing);

  // Load existing image for edit mode
  useEffect(() => {
    if (isEditMode && editDrop && currentUserId) {
      if (editDrop.imageR2Key) {
        if (editDrop.imageData) {
          // Already decrypted (from handleEditDrop or previous decrypt)
          setExistingImageUrl(editDrop.imageData);
        } else if (editDrop.encrypted) {
          // Still encrypted — decrypt to get image
          setDecryptingImage(true);
          decryptDrop(editDrop, currentUserId).then(decrypted => {
            if (decrypted.imageData) {
              setExistingImageUrl(decrypted.imageData);
            }
          }).finally(() => {
            setDecryptingImage(false);
          });
        }
      }
    }
  }, [isEditMode, editDrop, currentUserId]);

  // Extract Excalidraw scene from drawing PNG when editing
  useEffect(() => {
    if (!isEditMode || !editDrop?.isDrawing || !existingImageUrl) return;

    let cancelled = false;
    setExtractingScene(true);

    fetch(existingImageUrl)
      .then(res => res.blob())
      .then(async (blob) => {
        const { loadFromBlob } = await import('@excalidraw/excalidraw');
        const scene = await loadFromBlob(blob, null, null);
        if (!cancelled) {
          setInitialScene({ elements: scene.elements, appState: scene.appState, files: scene.files || undefined });
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

    return () => { cancelled = true; };
  }, [isEditMode, editDrop?.isDrawing, existingImageUrl]);

  const tc = getEditorialThemeColors(theme);

  // contentEditable mention editor — renders #[Name](id) tokens as inline chips while typing,
  // but keeps `content` as the plain token string (encrypt/save round-trip unchanged).
  const mentionChipBase = `inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass}`;
  const mention = useMentionEditor({
    content,
    setContent,
    allDrops: mentionableDrops,
    excludeDropId: editDrop?.id,
    foundClassName: `${mentionChipBase} ${tc.activePillBg} ${tc.activePillText}`,
    deletedClassName: `${mentionChipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`,
  });

  // Reproduce the old textarea's autoFocus on the contentEditable editor.
  useEffect(() => {
    mention.editorRef.current?.focus();
    // editorRef is a stable ref object; we only want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev => {
      if (prev.includes(cat)) return prev.filter(c => c !== cat);
      if (prev.length >= 3) return prev;
      return [...prev, cat];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFileDrop && !content.trim() && !drawingFile) return;

    // Standard users editing a forever drop can't save it (the rules reject the write). Show the
    // edit popup instead. Switching to a timed option and saving still works (that's a downgrade).
    if (isEditMode && tier === 'standard' && !tierLoading && expiration === 'forever') {
      setForeverContext('edit');
      setShowForeverLocked(true);
      return;
    }

    setLoading(true);
    const imageToUpload = drawingFile || attachedImage || undefined;
    if (isEditMode && editDrop && onEdit) {
      await onEdit(editDrop, {
        name: name.trim() || editDrop.name,
        ...(!isFileDrop && content !== editDrop.content ? { content } : {}),
        categories: selectedCategories,
        expirationOption: expiration,
        ...(!isFileDrop ? { imageFile: imageToUpload, imageRemoved } : {}),
        // Only creator/owner may send locked — a non-creator edit must omit it or the rules'
        // field-guard rejects the save.
        ...(canMutate ? { locked } : {}),
      });
    } else {
      await onSubmit(name.trim() || 'Text snippet', content, expiration, selectedCategories[0] || undefined, imageToUpload, selectedCategories, !!drawingFile, locked);
    }
    setLoading(false);
  };

  const removeExistingImage = () => {
    setExistingImageUrl(null);
    setImageRemoved(true);
  };

  const handleCreateCustomCategory = async () => {
    if (!customCategoryName.trim()) return;
    if (!onCreateCategory) return;

    setCreatingCategory(true);
    try {
      const newCategory = await onCreateCategory(customCategoryName.trim());
      if (newCategory) {
        if (selectedCategories.length < 3) {
          setSelectedCategories(prev => [...prev, newCategory]);
        }
        setShowCustomInput(false);
        setCustomCategoryName('');
      }
    } catch (error) {
      console.error('Error creating category:', error);
    }
    setCreatingCategory(false);
  };

  const hasChanges = isEditMode && editDrop ? (
    name.trim() !== (editDrop.name || '') ||
    JSON.stringify(selectedCategories.sort()) !== JSON.stringify((editDrop.categories || (editDrop.category ? [editDrop.category] : [])).sort()) ||
    expiration !== editDrop.expirationOption ||
    (!isFileDrop && content !== (editDrop.content || '')) ||
    !!attachedImage ||
    imageRemoved ||
    !!drawingFile ||
    locked !== (editDrop.locked ?? false)
  ) : true;

  const handleModeSwitch = (newMode: 'text' | 'draw') => {
    if (newMode === mode) return;
    if (mode === 'draw' && hasDrawn) {
      setShowDiscardConfirm(true);
      return;
    }
    setMode(newMode);
    setDrawingFile(null);
    setHasDrawn(false);
  };

  const confirmDiscard = () => {
    setShowDiscardConfirm(false);
    setMode('text');
    setDrawingFile(null);
    setHasDrawn(false);
  };

  const handleDrawingSave = (file: File) => {
    setDrawingFile(file);
    setHasDrawn(false);
    setMode('text');
  };

  const handleDrawingCancel = () => {
    if (isEditMode && editDrop?.isDrawing) {
      onClose();
      return;
    }
    setMode('text');
    setHasDrawn(false);
  };

  const toggleRecording = useCallback(async () => {
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('file', blob, 'recording.webm');
          const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
          const data = await res.json();
          if (data.text) {
            setContent(prev => prev ? prev + '\n' + data.text : data.text);
          }
        } catch (err) {
          console.error('Transcription failed:', err);
        }
        setIsTranscribing(false);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [isRecording]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    setAttachedImage(file);
    setImageRemoved(false);
    setExistingImageUrl(null);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setAttachedImage(file);
    setImageRemoved(false);
    setExistingImageUrl(null);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setAttachedImage(null);
    setImagePreview(null);
    // If there was an existing image and user selects then removes a new one, restore existing state
    if (existingImageUrl) {
      setImageRemoved(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 z-50 transition-colors duration-300 overscroll-contain overflow-y-auto flex items-start sm:items-center justify-center p-4 pt-[env(safe-area-inset-top,16px)] pb-[env(safe-area-inset-bottom,16px)] min-h-screen min-h-[100dvh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer.files[0];
        if (file) handleImageFile(file);
      }}
      onPaste={(e) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            e.stopPropagation();
            e.preventDefault();
            const file = items[i].getAsFile();
            if (file) handleImageFile(file);
            break;
          }
        }
      }}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-lg my-4 sm:my-auto max-h-[80vh] sm:max-h-[90vh] flex flex-col overflow-hidden transition-colors duration-300 shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
            {isFileDrop ? 'Edit file' : isEditMode ? 'Edit drop' : 'Add text snippet'}
          </h2>
          <button
            onClick={onClose}
            className={`${tc.muted} hover:${tc.text} transition-colors p-1`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Category Selection */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Categories <span className="opacity-50">(max 3)</span>
              </label>
              {!showCustomInput ? (
                <div className="flex flex-wrap gap-2">
                  {BUILT_IN_CATEGORIES.map((cat) => (
                    <button
                      key={cat.value}
                      type="button"
                      onClick={() => toggleCategory(cat.value)}
                      disabled={!selectedCategories.includes(cat.value) && selectedCategories.length >= 3}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} disabled:opacity-30 ${
                        selectedCategories.includes(cat.value)
                          ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                  {customCategories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      disabled={!selectedCategories.includes(cat) && selectedCategories.length >= 3}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} disabled:opacity-30 ${
                        selectedCategories.includes(cat)
                          ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                  {onCreateCategory && (
                    <button
                      type="button"
                      onClick={() => setShowCustomInput(true)}
                      className={`px-3 py-1.5 text-xs rounded-full border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-colors flex items-center gap-1 ${tc.fontClass}`}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Custom
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={customCategoryName}
                    onChange={(e) => setCustomCategoryName(e.target.value)}
                    placeholder="Category name..."
                    className={`flex-1 border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCreateCustomCategory}
                      disabled={!customCategoryName.trim() || creatingCategory}
                      className={`flex-1 sm:flex-none px-3 py-2 ${tc.activePillBg} ${tc.activePillText} text-xs rounded-full hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity ${tc.fontClass}`}
                    >
                      {creatingCategory ? '...' : 'Add'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCustomInput(false);
                        setCustomCategoryName('');
                      }}
                      className={`flex-1 sm:flex-none px-3 py-2 border ${tc.border} ${tc.text} text-xs rounded-full hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Name */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Name (optional)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Text snippet"
                className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-4 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
              />
            </div>

            {!isFileDrop && (<>

          {/* Text / Draw toggle — only in create mode */}
          {!isEditMode && (
            <div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleModeSwitch('text')}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                    mode === 'text'
                      ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                      : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => handleModeSwitch('draw')}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                    mode === 'draw'
                      ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                      : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                  </svg>
                  Draw
                </button>
              </div>
            </div>
          )}

          {/* Drawing canvas */}
          {mode === 'draw' && (!isEditMode || !!editDrop?.isDrawing) && (
            <div>
              {(!isEditMode || !!editDrop?.isDrawing) && (
                <div className="flex items-center gap-2 mb-3">
                  <label className={`block text-xs ${tc.muted} ${tc.fontClass}`}>
                    Background
                  </label>
                  <div className="flex gap-1.5">
                    {BG_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setBgColor(c.value)}
                        className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                          bgColor === c.value
                            ? `${theme === 'dark' ? 'border-white scale-110' : 'border-[#1A1A1A] scale-110'}`
                            : `${theme === 'dark' ? 'border-white/30' : 'border-[#1a1a1a]/20'}`
                        }`}
                        style={{ backgroundColor: c.value }}
                        title={c.label}
                      />
                    ))}
                  </div>
                </div>
              )}
              {extractingScene ? (
                <div className={`flex items-center justify-center h-[350px] border ${tc.border} rounded-lg`}>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
                    <span className={`text-xs ${tc.muted} ${tc.fontClass}`}>Loading drawing...</span>
                  </div>
                </div>
              ) : (
                <DrawingCanvas
                  onSave={handleDrawingSave}
                  onCancel={handleDrawingCancel}
                  onDraw={() => setHasDrawn(true)}
                  theme={theme}
                  bgColor={bgColor}
                  initialScene={initialScene || undefined}
                />
              )}
            </div>
          )}

          {/* Discard drawing confirmation */}
          {showDiscardConfirm && (
            <div className={`border ${tc.border} ${tc.bg} p-4 rounded-lg`}>
              <p className={`text-sm ${tc.text} mb-3 ${tc.fontClass}`}>
                Discard drawing?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmDiscard}
                  className="px-3 py-1.5 bg-red-500 text-white text-xs rounded-full hover:bg-red-600 transition-colors"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiscardConfirm(false)}
                  className={`px-3 py-1.5 border ${tc.border} ${tc.text} text-xs rounded-full hover:border-[#1a1a1a] transition-colors`}
                >
                  Keep drawing
                </button>
              </div>
            </div>
          )}

          {/* Drawing saved indicator */}
          {drawingFile && mode === 'text' && (!isEditMode || !!editDrop?.isDrawing) && (
            <div className={`border ${tc.border} rounded-lg overflow-hidden`}>
              <div className={`flex items-center gap-2 px-3 py-2 ${tc.bg}`}>
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className={`text-xs ${tc.text} ${tc.fontClass}`}>Drawing attached</span>
                <button
                  type="button"
                  onClick={() => setDrawingFile(null)}
                  className={`ml-auto ${tc.muted} hover:text-red-500 transition-colors`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Content textarea — show in text mode or edit mode (not for drawing edits) */}
          {(mode === 'text' || isEditMode) && (
            <div className="relative">
              <div className="flex items-center justify-between mb-2">
                <label className={`block text-xs ${tc.muted} ${tc.fontClass}`}>
                  Content
                </label>
                <button
                  type="button"
                  onClick={toggleRecording}
                  disabled={isTranscribing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                    isRecording
                      ? 'bg-red-500 border-red-500 text-white'
                      : isTranscribing
                        ? `${tc.border} ${tc.muted} opacity-50 cursor-wait`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                  }`}
                >
                  {isTranscribing ? (
                    <>
                      <div className="w-3 h-3 border border-current/30 border-t-current animate-spin rounded-full" />
                      Transcribing...
                    </>
                  ) : isRecording ? (
                    <>
                      <span className="w-2 h-2 bg-white rounded-sm" />
                      Stop
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                      </svg>
                      Voice
                    </>
                  )}
                </button>
              </div>
              {/* contentEditable mention editor: chips render live while typing, but the saved
                  value stays the plain #[Name](id) token string (see useMentionEditor). */}
              <div className="relative">
                {/* #-mention dropdown — floats just above the editor */}
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
                  <span className={`pointer-events-none absolute left-4 top-3 text-sm ${tc.fontClass} ${theme === 'dark' ? 'text-white/30' : 'text-[#1A1A1A]/30'}`}>
                    Enter your text here...
                  </span>
                )}
                <div
                  ref={mention.editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={mention.handleInput}
                  onKeyDown={mention.handleKeyDown}
                  onBlur={mention.handleBlur}
                  role="textbox"
                  aria-multiline="true"
                  className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-4 py-3 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass} min-h-[140px] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words`}
                />
              </div>
            </div>
          )}

          {/* Image attachment — show in text mode or edit mode (not for drawing edits) */}
          {(mode === 'text' || (isEditMode && !editDrop?.isDrawing)) && !drawingFile && (
            <div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
              {/* New image preview (just selected) */}
              {imagePreview ? (
                <div className={`relative border ${tc.border} rounded-lg overflow-hidden`}>
                  <img src={imagePreview} alt="Attached" className="w-full max-h-32 object-cover" />
                  <button
                    type="button"
                    onClick={removeImage}
                    className="absolute top-2 right-2 w-6 h-6 bg-[#1a1a1a]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1a1a1a] transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <div className={`absolute bottom-2 left-2 px-2 py-1 bg-[#1a1a1a]/80 text-white text-[10px] ${tc.fontClass} rounded`}>
                    New image
                  </div>
                </div>
              ) : existingImageUrl && !imageRemoved ? (
                /* Existing image from the drop */
                <div className={`relative border ${tc.border} rounded-lg overflow-hidden`}>
                  {decryptingImage ? (
                    <div className={`w-full h-32 flex items-center justify-center ${tc.bg}`}>
                      <div className="w-5 h-5 border border-current/30 border-t-current animate-spin rounded-full ${tc.muted}" />
                    </div>
                  ) : (
                    <img src={existingImageUrl} alt="Current image" className="w-full max-h-32 object-cover" />
                  )}
                  <button
                    type="button"
                    onClick={removeExistingImage}
                    className="absolute top-2 right-2 w-6 h-6 bg-[#1a1a1a]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1a1a1a] transition-colors"
                    title="Remove image"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="absolute bottom-2 right-2 px-2 py-1 bg-[#1a1a1a]/80 text-white text-[10px] rounded hover:bg-[#1a1a1a] transition-colors flex items-center gap-1"
                    title="Replace image"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                    Replace
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className={`w-full border border-dashed ${tc.border} ${tc.text} ${tc.bg} px-4 py-3 text-xs rounded-lg hover:border-[#1a1a1a] transition-colors flex items-center justify-center gap-2 ${tc.fontClass}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18 2.25H6A2.25 2.25 0 003.75 4.5v15A2.25 2.25 0 006 21.75h12A2.25 2.25 0 0020.25 19.5v-15A2.25 2.25 0 0018 2.25z" />
                  </svg>
                  Attach image (optional)
                </button>
              )}
            </div>
          )}

          </>)}

            {/* Expiration selector */}
            <div>
              <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                Expires after
              </label>
              <div className="flex flex-wrap gap-2">
                {EXPIRATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      if (option.value === 'forever' && tier === 'standard' && !tierLoading) {
                        setForeverContext('create');
                        setShowForeverLocked(true);
                        return;
                      }
                      setExpiration(option.value);
                    }}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      expiration === option.value
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Lock toggle — create mode (shared workspace) or edit mode (creator/owner). */}
            {showLockToggle && (
              <div>
                <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-2`}>
                  Access
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setLocked(false)}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      !locked
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocked(true)}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      locked
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    Locked
                  </button>
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className={`flex-1 border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || (isEditMode && !hasChanges) || (!isFileDrop && !content.trim() && !drawingFile)}
                className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2 ${tc.fontClass}`}
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                    Saving...
                  </>
                ) : (
                  isEditMode ? 'Save changes' : 'Save'
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
      {showForeverLocked && (
        <ForeverLockedModal context={foreverContext} variant="editorial" theme={theme} onClose={() => setShowForeverLocked(false)} />
      )}
    </div>
  );
}
