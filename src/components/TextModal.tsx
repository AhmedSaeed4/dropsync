'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Drop, ExpirationOption } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { decryptDrop } from '@/lib/drops';
import { DrawingCanvas, BG_COLORS } from './DrawingCanvas';

interface TextModalProps {
  onSubmit: (name: string, content: string, expiration: ExpirationOption, category?: string, imageFile?: File, categories?: string[], isDrawing?: boolean) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  editDrop?: Drop | null;
  onEdit?: (drop: Drop, updates: { name?: string; content?: string; category?: string | null; categories?: string[]; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean }) => Promise<boolean>;
  currentUserId?: string;
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

export function TextModal({ onSubmit, onClose, theme = 'light', customCategories = [], onCreateCategory, editDrop, onEdit, currentUserId }: TextModalProps) {
  useBodyScrollLock();
  const isEditMode = !!editDrop;
  const [name, setName] = useState(editDrop?.name || '');
  const [content, setContent] = useState(editDrop?.content || '');
  const [loading, setLoading] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>(editDrop?.expirationOption || '2h');
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
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const isFileDrop = isEditMode && editDrop?.type === 'file';
  const [mode, setMode] = useState<'text' | 'draw'>('text');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [hasDrawn, setHasDrawn] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);

  // Load existing image for edit mode
  useEffect(() => {
    if (isEditMode && editDrop && currentUserId) {
      if (editDrop.imageR2Key) {
        if (editDrop.imageData) {
          setExistingImageUrl(editDrop.imageData);
        } else if (editDrop.encrypted) {
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

    setLoading(true);
    const imageToUpload = drawingFile || attachedImage || undefined;
    if (isEditMode && editDrop && onEdit) {
      await onEdit(editDrop, {
        name: name.trim() || editDrop.name,
        ...(!isFileDrop && content !== editDrop.content ? { content } : {}),
        categories: selectedCategories,
        expirationOption: expiration,
        imageFile: imageToUpload,
        imageRemoved: imageRemoved,
      });
    } else {
      await onSubmit(name.trim() || (isMinimal ? 'Text snippet' : 'TEXT_SNIPPET'), content, expiration, selectedCategories[0] || undefined, imageToUpload, selectedCategories, !!drawingFile);
    }
    setLoading(false);
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

  const toggleRecording = useCallback(async () => {
    if (isRecording && mediaRecorderRef.current) {
      // Stop recording
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
    if (existingImageUrl) {
      setImageRemoved(false);
    }
  };

  const removeExistingImage = () => {
    setExistingImageUrl(null);
    setImageRemoved(true);
  };

  const hasChanges = isEditMode && editDrop ? (
    name.trim() !== (editDrop.name || '') ||
    JSON.stringify(selectedCategories.sort()) !== JSON.stringify((editDrop.categories || (editDrop.category ? [editDrop.category] : [])).sort()) ||
    expiration !== editDrop.expirationOption ||
    (!isFileDrop && content !== (editDrop.content || '')) ||
    !!attachedImage ||
    imageRemoved ||
    !!drawingFile
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
    setMode('text');
    setHasDrawn(false);
  };

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        inputBg: 'bg-[#C5C9B8]',
        placeholderColor: 'placeholder:text-[#1A1A1A]/30',
        headerBg: 'bg-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        overlayBg: 'bg-[#1A1A1A]/70',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      placeholderColor: isDark ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30',
      headerBg: 'bg-[#FF5A47]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      overlayBg: 'bg-[#1A1A1A]/90',
    };
  };

  const tc = getThemeColors();

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain overflow-y-auto`}
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
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-lg my-auto max-h-[90vh] flex flex-col overflow-hidden transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between shrink-0 ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {isFileDrop
              ? (isMinimal ? 'Edit file' : 'EDIT/FILE')
              : isEditMode
                ? (isMinimal ? 'Edit drop' : 'EDIT/DROP')
                : (isMinimal ? 'Add text snippet' : 'ADD/TEXT_SNIPPET')
            }
          </h2>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Category Selection */}
          <div>
            <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>
              {isMinimal ? 'Categories' : 'CATEGORIES'} <span className="opacity-50">(max 3)</span>
            </label>
            {!showCustomInput ? (
              <div className="flex flex-wrap gap-2">
                {/* Built-in categories */}
                {BUILT_IN_CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    type="button"
                    onClick={() => toggleCategory(cat.value)}
                    disabled={!selectedCategories.includes(cat.value) && selectedCategories.length >= 3}
                    className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border transition-colors disabled:opacity-30 ${
                      selectedCategories.includes(cat.value)
                        ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                        : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                    }`}
                  >
                    {isMinimal ? cat.label : cat.label.toUpperCase()}
                  </button>
                ))}
                {/* Custom categories */}
                {customCategories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    disabled={!selectedCategories.includes(cat) && selectedCategories.length >= 3}
                    className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border transition-colors disabled:opacity-30 ${
                      selectedCategories.includes(cat)
                        ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                        : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                    }`}
                  >
                    {isMinimal ? cat : cat.toUpperCase()}
                  </button>
                ))}
                {/* Add custom button */}
                {onCreateCategory && (
                  <button
                    type="button"
                    onClick={() => setShowCustomInput(true)}
                    className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border ${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10 transition-colors flex items-center gap-1`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    {isMinimal ? 'Custom' : 'CUSTOM'}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={customCategoryName}
                  onChange={(e) => setCustomCategoryName(e.target.value)}
                  placeholder={isMinimal ? 'Category name...' : 'CATEGORY_NAME...'}
                  className={`flex-1 border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-3 py-2 text-sm ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass}`}
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleCreateCustomCategory}
                    disabled={!customCategoryName.trim() || creatingCategory}
                    className={`flex-1 sm:flex-none px-3 py-2 bg-[#1A1A1A] text-white text-xs ${isMinimal ? 'rounded-full' : ''} hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors`}
                  >
                    {creatingCategory ? '...' : isMinimal ? 'Add' : 'ADD'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomInput(false);
                      setCustomCategoryName('');
                    }}
                    className={`flex-1 sm:flex-none px-3 py-2 border ${tc.borderColor} ${tc.textColor} text-xs ${isMinimal ? 'rounded-full' : ''} hover:bg-[#1A1A1A]/10 transition-colors`}
                  >
                    {isMinimal ? 'Cancel' : 'CANCEL'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>
              {isMinimal ? 'Name (optional)' : 'IDENTIFIER (OPTIONAL)'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isMinimal ? 'Text snippet' : 'TEXT_SNIPPET'}
              className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm ${isMinimal ? 'font-sans tracking-wide' : 'uppercase tracking-wider'} ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass}`}
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
                  className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border transition-colors ${
                    mode === 'text'
                      ? `${isDark ? 'bg-white text-[#0D0D0D] border-white' : 'bg-[#1A1A1A] text-white border-[#1A1A1A]'}`
                      : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  {isMinimal ? 'Text' : 'TEXT'}
                </button>
                <button
                  type="button"
                  onClick={() => handleModeSwitch('draw')}
                  className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border transition-colors ${
                    mode === 'draw'
                      ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                      : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                  }`}
                >
                  <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                  </svg>
                  {isMinimal ? 'Draw' : 'DRAW'}
                </button>
              </div>
            </div>
          )}

          {/* Drawing canvas */}
          {mode === 'draw' && !isEditMode && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <label className={`block ${tc.fontClass} ${tc.textMuted}`}>
                  {isMinimal ? 'Background' : 'BG_COLOR'}
                </label>
                <div className="flex gap-1.5">
                  {BG_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setBgColor(c.value)}
                      className={`w-6 h-6 ${isMinimal ? 'rounded-full' : ''} border-2 transition-transform hover:scale-110 ${
                        bgColor === c.value
                          ? `${isDark ? 'border-white scale-110' : 'border-[#1A1A1A] scale-110'}`
                          : `${isDark ? 'border-white/30' : 'border-[#1a1a1a]/20'}`
                      }`}
                      style={{ backgroundColor: c.value }}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>
              <DrawingCanvas
                onSave={handleDrawingSave}
                onCancel={handleDrawingCancel}
                onDraw={() => setHasDrawn(true)}
                theme={theme}
                bgColor={bgColor}
              />
            </div>
          )}

          {/* Discard drawing confirmation */}
          {showDiscardConfirm && (
            <div className={`border ${tc.borderColor} ${tc.inputBg} p-4 ${tc.roundedClass}`}>
              <p className={`text-sm ${tc.textColor} mb-3 ${isMinimal ? 'font-sans' : 'font-mono'}`}>
                {isMinimal ? 'Discard drawing?' : 'DISCARD_DRAWING?'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmDiscard}
                  className="px-3 py-1.5 bg-red-500 text-white text-xs hover:bg-red-600 transition-colors"
                >
                  {isMinimal ? 'Discard' : 'DISCARD'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiscardConfirm(false)}
                  className={`px-3 py-1.5 border ${tc.borderColor} ${tc.textColor} text-xs hover:bg-[#1A1A1A]/10 transition-colors`}
                >
                  {isMinimal ? 'Keep drawing' : 'KEEP_DRAWING'}
                </button>
              </div>
            </div>
          )}

          {/* Drawing saved indicator */}
          {drawingFile && mode === 'text' && !isEditMode && (
            <div className={`border ${tc.borderColor} ${tc.roundedClass} overflow-hidden`}>
              <div className={`flex items-center gap-2 px-3 py-2 ${tc.inputBg}`}>
                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className={`text-xs ${tc.textColor}`}>Drawing attached</span>
                <button
                  type="button"
                  onClick={() => setDrawingFile(null)}
                  className={`ml-auto ${tc.textMuted} hover:text-red-500 transition-colors`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Content textarea — show in text mode or edit mode */}
          {(mode === 'text' || isEditMode) && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={`block ${tc.fontClass} ${tc.textMuted}`}>
                {isMinimal ? 'Content' : 'CONTENT/DATA'}
              </label>
              <button
                type="button"
                onClick={toggleRecording}
                disabled={isTranscribing}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs border transition-colors ${
                  isRecording
                    ? 'bg-red-500 border-red-500 text-white'
                    : isTranscribing
                      ? `${tc.borderColor} ${tc.textMuted} opacity-50 cursor-wait`
                      : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A] hover:text-white`
                } ${isMinimal ? 'rounded-full' : ''}`}
              >
                {isTranscribing ? (
                  <>
                    <div className="w-3 h-3 border border-current/30 border-t-current animate-spin rounded-full" />
                    {isMinimal ? 'Transcribing...' : 'TRANSCRIBING...'}
                  </>
                ) : isRecording ? (
                  <>
                    <span className="w-2 h-2 bg-white rounded-sm" />
                    {isMinimal ? 'Stop' : 'STOP'}
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                    {isMinimal ? 'Voice' : 'VOICE'}
                  </>
                )}
              </button>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={isMinimal ? 'Enter your text here...' : 'ENTER_CONTENT_HERE...'}
              rows={8}
              required={mode === 'text' || isEditMode}
              className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm ${isMinimal ? 'font-sans' : 'font-mono'} ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent resize-none transition-colors duration-300 ${tc.roundedClass}`}
            />
          </div>
          )}

          {/* Image attachment — show in text mode or edit mode */}
          {(mode === 'text' || isEditMode) && !drawingFile && (
          <div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden"
            />
            {imagePreview ? (
              <div className={`relative border ${tc.borderColor} ${tc.roundedClass} overflow-hidden`}>
                <img src={imagePreview} alt="Attached" className="w-full max-h-40 object-cover" />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute top-2 right-2 w-6 h-6 bg-[#1A1A1A]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1A1A1A] transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div className={`absolute bottom-2 left-2 px-2 py-1 bg-[#1A1A1A]/80 text-white text-[10px] ${isMinimal ? 'rounded' : ''}`}>
                  New image
                </div>
              </div>
            ) : existingImageUrl && !imageRemoved ? (
              <div className={`relative border ${tc.borderColor} ${tc.roundedClass} overflow-hidden`}>
                {decryptingImage ? (
                  <div className={`w-full h-32 flex items-center justify-center ${tc.inputBg}`}>
                    <div className={`w-5 h-5 border border-current/30 border-t-current animate-spin rounded-full ${tc.textMuted}`} />
                  </div>
                ) : (
                  <img src={existingImageUrl} alt="Current image" className="w-full max-h-40 object-cover" />
                )}
                <button
                  type="button"
                  onClick={removeExistingImage}
                  className="absolute top-2 right-2 w-6 h-6 bg-[#1A1A1A]/80 text-white rounded-full flex items-center justify-center hover:bg-[#1A1A1A] transition-colors"
                  title="Remove image"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className={`absolute bottom-2 right-2 px-2 py-1 bg-[#1A1A1A]/80 text-white text-[10px] hover:bg-[#1A1A1A] transition-colors flex items-center gap-1 ${isMinimal ? 'rounded-full' : ''}`}
                  title="Replace image"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                  </svg>
                  {isMinimal ? 'Replace' : 'REPLACE'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className={`w-full border border-dashed ${tc.borderColor} ${tc.textColor} ${tc.inputBg} px-4 py-3 text-xs ${isMinimal ? 'rounded-lg font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${tc.placeholderColor} hover:bg-[#1A1A1A]/5 transition-colors flex items-center justify-center gap-2`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18 2.25H6A2.25 2.25 0 003.75 4.5v15A2.25 2.25 0 006 21.75h12A2.25 2.25 0 0020.25 19.5v-15A2.25 2.25 0 0018 2.25z" />
                </svg>
                {isMinimal ? 'Attach image (optional)' : 'ATTACH_IMAGE (OPTIONAL)'}
              </button>
            )}
          </div>
          )}

          </>)}

          {/* Expiration selector */}
          <div>
            <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>
              {isMinimal ? 'Expires after' : 'EXPIRES_AFTER'}
            </label>
            <div className="flex flex-wrap gap-2">
              {EXPIRATION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setExpiration(option.value)}
                  className={`px-3 py-2 text-xs ${isMinimal ? 'rounded-full' : ''} border transition-colors ${
                    expiration === option.value
                      ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                      : `${tc.borderColor} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                  }`}
                >
                  {isMinimal ? option.label : option.label.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className={`flex-1 border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
            >
              {isMinimal ? 'Cancel' : 'CANCEL'}
            </button>
            <button
              type="submit"
              disabled={loading || (isEditMode && !hasChanges) || (!isFileDrop && !content.trim() && !drawingFile)}
              className={`flex-1 bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  {isMinimal ? 'Saving...' : 'UPLOADING...'}
                </>
              ) : (
                isEditMode
                  ? (isMinimal ? 'Save changes' : 'SAVE_CHANGES')
                  : (isMinimal ? 'Save' : 'CONFIRM')
              )}
            </button>
          </div>
          </div>
        </form>
      </div>
    </div>
  );
}