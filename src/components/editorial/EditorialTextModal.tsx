'use client';

import { useState, useRef, useCallback } from 'react';
import { ExpirationOption } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialTextModalProps {
  onSubmit: (name: string, content: string, expiration: ExpirationOption, category?: string, imageFile?: File) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
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

export function EditorialTextModal({ onSubmit, onClose, theme = 'light', customCategories = [], onCreateCategory }: EditorialTextModalProps) {
  useBodyScrollLock();
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const [category, setCategory] = useState<string>('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCategoryName, setCustomCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const tc = getEditorialThemeColors(theme);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    await onSubmit(name.trim() || 'Text snippet', content, expiration, category || undefined, attachedImage || undefined);
    setLoading(false);
  };

  const handleCreateCustomCategory = async () => {
    if (!customCategoryName.trim()) return;
    if (!onCreateCategory) return;

    setCreatingCategory(true);
    try {
      const newCategory = await onCreateCategory(customCategoryName.trim());
      if (newCategory) {
        setCategory(newCategory);
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
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setAttachedImage(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setAttachedImage(null);
    setImagePreview(null);
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
            const file = items[i].getAsFile();
            if (file) handleImageFile(file);
            break;
          }
        }
      }}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-lg my-4 sm:my-auto max-h-[90vh] flex flex-col overflow-hidden transition-colors duration-300 shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
            Add text snippet
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
                Category
              </label>
              {!showCustomInput ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setCategory('')}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                      category === ''
                        ? `${tc.activePillBg} ${tc.activePillText} border-[#1a1a1a]`
                        : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                    }`}
                  >
                    None
                  </button>
                  {BUILT_IN_CATEGORIES.map((cat) => (
                    <button
                      key={cat.value}
                      type="button"
                      onClick={() => setCategory(cat.value)}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                        category === cat.value
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
                      onClick={() => setCategory(cat)}
                      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${tc.fontClass} ${
                        category === cat
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

            <div>
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
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Enter your text here..."
                rows={6}
                required
                className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-4 py-3 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] resize-none transition-colors ${tc.fontClass}`}
              />
            </div>

            {/* Image attachment */}
            <div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
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
                    onClick={() => setExpiration(option.value)}
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
                disabled={loading || !content.trim()}
                className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2 ${tc.fontClass}`}
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
