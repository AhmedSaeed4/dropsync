'use client';

import { useState, useEffect } from 'react';

const STORAGE_KEY = 'dropsync_saved_paths';

interface SavedPathsProps {
  theme?: 'light' | 'dark' | 'minimal';
}

export function SavedPaths({ theme = 'light' }: SavedPathsProps) {
  const [paths, setPaths] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showInput, setShowInput] = useState(false);

  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

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
  };

  const removePath = (index: number) => {
    save(paths.filter((_, i) => i !== index));
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditValue(paths[index]);
  };

  const saveEdit = (index: number) => {
    const trimmed = editValue.trim();
    if (!trimmed) return;
    const updated = [...paths];
    updated[index] = trimmed;
    save(updated);
    setEditingIndex(null);
  };

  const copyPath = async (index: number) => {
    await navigator.clipboard.writeText(paths[index]);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  const tc = isMinimal
    ? { border: 'border-[#1A1A1A]/20', bg: 'bg-[#D4D8C8]', headerBg: 'bg-[#1A1A1A]/5', text: 'text-[#1A1A1A]', muted: 'text-[#1A1A1A]/50', inputBg: 'bg-[#C5C9B8]', rounded: 'rounded-lg', font: 'font-sans tracking-wide', inputPh: 'placeholder:text-[#1A1A1A]/30' }
    : isDark
      ? { border: 'border-white/10', bg: 'bg-[#1A1A1A]', headerBg: 'bg-white/5', text: 'text-white', muted: 'text-white/50', inputBg: 'bg-[#0D0D0D]', rounded: '', font: 'font-mono uppercase tracking-wider', inputPh: 'placeholder:text-white/30' }
      : { border: 'border-[#1A1A1A]', bg: 'bg-[#FAF7F2]', headerBg: 'bg-[#1A1A1A]', text: 'text-[#1A1A1A]', muted: 'text-[#1A1A1A]/50', inputBg: 'bg-white', rounded: '', font: 'font-mono uppercase tracking-wider', inputPh: 'placeholder:text-[#1A1A1A]/30' };

  return (
    <div className={`border ${tc.border} ${tc.bg} ${isMinimal ? 'rounded-lg' : ''} transition-colors duration-300`}>
      {/* Header — double-click to toggle input */}
      <div
        onDoubleClick={() => setShowInput(!showInput)}
        className={`border-b ${showInput ? tc.border : 'border-transparent'} px-4 py-2.5 ${isMinimal ? tc.headerBg : tc.headerBg} cursor-pointer select-none`}
      >
        <h3 className={`text-[10px] ${tc.font} ${isMinimal ? 'text-[#1A1A1A]/70' : isDark ? 'text-white/60' : 'text-white'}`}>
          {isMinimal ? 'Saved paths' : 'SAVED_PATHS'}
        </h3>
      </div>

      {/* Add path input — slide drawer */}
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${showInput ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="p-3 pb-1.5 flex gap-1.5">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPath()}
              placeholder={isMinimal ? 'Add a path...' : 'PATH...'}
              className={`flex-1 border ${tc.border} ${tc.inputBg} ${tc.text} px-2.5 py-1.5 text-[11px] ${tc.inputPh} focus:outline-none focus:ring-1 focus:ring-[#1A1A1A] ${isMinimal ? 'rounded-lg' : ''} transition-colors duration-300`}
            />
            <button
              onClick={addPath}
              disabled={!newPath.trim()}
              className={`px-2.5 py-1.5 bg-[#1A1A1A] text-white text-[10px] ${isMinimal ? 'rounded-lg' : ''} hover:bg-[#2A2A2A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Paths list */}
      {(paths.length > 0 || !showInput) && (
        <div className={`p-3 ${showInput ? 'pt-1.5' : ''} space-y-2`}>
          {paths.map((path, i) => (
            <div key={i} className={`flex items-center gap-1.5 border ${tc.border} ${tc.inputBg} ${isMinimal ? 'rounded-lg' : ''} overflow-hidden`}>
              {editingIndex === i ? (
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(i); if (e.key === 'Escape') setEditingIndex(null); }}
                  onBlur={() => saveEdit(i)}
                  autoFocus
                  className={`flex-1 px-2.5 py-1.5 text-[11px] ${tc.text} bg-transparent focus:outline-none ${isMinimal ? 'font-sans' : 'font-mono'}`}
                />
              ) : (
                <p
                  onDoubleClick={() => startEdit(i)}
                  className={`flex-1 px-2.5 py-1.5 text-[11px] ${tc.text} ${tc.muted} truncate cursor-default ${isMinimal ? 'font-sans tracking-wide' : 'font-mono'}`}
                  title={`${path}\nDouble-click to edit`}
                >
                  {path}
                </p>
              )}

              {/* Copy */}
              <button
                onClick={() => copyPath(i)}
                className={`p-1.5 ${tc.muted} hover:text-[#1A1A1A] transition-colors`}
                title="Copy path"
              >
                {copiedIndex === i ? (
                  <svg className="w-3 h-3 text-[#FF5A47]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>

              {/* Delete (double-click) */}
              <button
                onDoubleClick={() => removePath(i)}
                className={`p-1.5 mr-0.5 ${tc.muted} hover:text-[#FF5A47] transition-colors`}
                title="Double-click to remove"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}

          {paths.length === 0 && !showInput && (
            <p className={`text-[10px] ${tc.muted} text-center py-1 ${tc.font}`}>
              {isMinimal ? 'No saved paths yet' : 'NO_PATHS_SAVED'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
