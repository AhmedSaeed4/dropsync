'use client';

import { useState, useEffect } from 'react';
import { getEditorialThemeColors } from './editorialTheme';

const STORAGE_KEY = 'dropsync_saved_paths';

interface EditorialSavedPathsProps {
  theme: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
}

export function EditorialSavedPaths({ theme, showChat = false }: EditorialSavedPathsProps) {
  const tc = getEditorialThemeColors(theme);

  const [paths, setPaths] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showInput, setShowInput] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setPaths(JSON.parse(stored)); } catch { setPaths([]); }
    }
  }, []);

  const save = (updated: string[]) => {
    setPaths(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const addPath = () => {
    const trimmed = newPath.trim();
    if (!trimmed || paths.includes(trimmed)) return;
    save([...paths, trimmed]);
    setNewPath('');
    setShowInput(false);
  };

  const removePath = (index: number) => {
    save(paths.filter((_, i) => i !== index));
  };

  const copyPath = async (index: number) => {
    await navigator.clipboard.writeText(paths[index]);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  return (
    <div className="transition-colors duration-300">
      {/* Section title with + button */}
      <div className="flex items-center justify-between mb-4">
        <h4 className={`text-[16px] font-medium ${tc.fontClass} ${tc.text}`}>
          Saved Paths
        </h4>
        <button
          onClick={() => setShowInput(!showInput)}
          className={`w-6 h-6 flex items-center justify-center border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
          title={showInput ? 'Cancel' : 'Add path'}
        >
          {showInput ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          )}
        </button>
      </div>

      {/* Add path input */}
      {showInput && (
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addPath(); if (e.key === 'Escape') setShowInput(false); }}
            placeholder="Enter path..."
            autoFocus
            className={`flex-1 px-3 py-2 text-[13px] ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg focus:outline-none focus:${tc.border}`}
          />
          <button
            onClick={addPath}
            disabled={!newPath.trim()}
            className={`px-4 py-2 text-[12px] ${tc.fontClass} ${tc.activePillBg} ${tc.activePillText} rounded-lg ${tc.inactivePillHoverBg} disabled:opacity-50 transition-colors`}
          >
            Add
          </button>
        </div>
      )}

      {/* Paths list */}
      <div className="space-y-2">
        {paths.map((path, i) => (
          <div
            key={i}
            className={`flex items-center justify-between px-4 py-3 ${tc.cardBg} border ${tc.border} rounded-lg transition-colors ${tc.hoverBorder}`}
          >
            <p
              className={`text-[13px] ${tc.fontClass} ${tc.text} truncate flex-1`}
              title={path}
            >
              {path}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => copyPath(i)}
                className={`text-[12px] ${tc.fontClass} px-3 py-1 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
              >
                {copiedIndex === i ? 'Copied' : 'Copy'}
              </button>
              <button
                onDoubleClick={() => removePath(i)}
                className={`p-1.5 border ${tc.border} ${tc.text} rounded hover:border-red-400 hover:text-red-500 transition-colors`}
                title="Double-click to delete"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {paths.length === 0 && (
          <p className={`text-[13px] ${tc.fontClass} ${tc.muted} py-2`}>
            No saved paths
          </p>
        )}
      </div>
    </div>
  );
}
