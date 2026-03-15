'use client';

import { useState } from 'react';
import { ExpirationOption } from '@/types';

interface TextModalProps {
  onSubmit: (name: string, content: string, expiration: ExpirationOption) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '2h', label: '2 hours' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: 'forever', label: 'Forever' },
];

export function TextModal({ onSubmit, onClose, theme = 'light' }: TextModalProps) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    await onSubmit(name.trim() || (isMinimal ? 'Text snippet' : 'TEXT_SNIPPET'), content, expiration);
    setLoading(false);
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
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-lg transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {isMinimal ? 'Add text snippet' : 'ADD/TEXT_SNIPPET'}
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

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
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

          <div>
            <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>
              {isMinimal ? 'Content' : 'CONTENT/DATA'}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={isMinimal ? 'Enter your text here...' : 'ENTER_CONTENT_HERE...'}
              rows={8}
              required
              className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm ${isMinimal ? 'font-sans' : 'font-mono'} ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent resize-none transition-colors duration-300 ${tc.roundedClass}`}
            />
          </div>

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
              disabled={loading || !content.trim()}
              className={`flex-1 bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  {isMinimal ? 'Saving...' : 'UPLOADING...'}
                </>
              ) : (
                isMinimal ? 'Save' : 'CONFIRM'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
