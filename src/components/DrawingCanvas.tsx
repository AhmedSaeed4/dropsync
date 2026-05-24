'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import '@excalidraw/excalidraw/index.css';

// Excalidraw doesn't support SSR — dynamic import
const Excalidraw = dynamic(
  () => import('@excalidraw/excalidraw').then((mod) => mod.Excalidraw),
  { ssr: false },
);

// Self-hosted fonts: tell Excalidraw to load from / instead of CDN
if (typeof window !== 'undefined') {
  (window as any).EXCALIDRAW_ASSET_PATH = '/';
}

interface DrawingCanvasProps {
  onSave: (pngFile: File) => void;
  onCancel: () => void;
  onDraw?: () => void;
  theme: 'light' | 'dark' | 'minimal';
  bgColor: string;
  initialScene?: { elements: any[]; appState: any };
}

const BG_COLORS = [
  { value: '#ffffff', label: 'White' },
  { value: '#f5f5f5', label: 'Light gray' },
  { value: '#fffef5', label: 'Cream' },
  { value: '#333333', label: 'Dark gray' },
  { value: '#000000', label: 'Black' },
];

export function DrawingCanvas({ onSave, onCancel, onDraw, theme, bgColor, initialScene }: DrawingCanvasProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const apiRef = useRef<any>(null);
  const elementsRef = useRef<any[]>([]);
  const filesRef = useRef<any>(null);
  const drawnRef = useRef(false);

  const isDark = theme === 'dark';
  const roundedClass = theme === 'minimal' ? 'rounded-lg' : 'rounded-lg';

  // Update background color in real-time when bgColor changes (skip for initial scene)
  useEffect(() => {
    if (apiRef.current) {
      apiRef.current.updateScene({
        appState: { viewBackgroundColor: bgColor },
      });
    }
  }, [bgColor, initialScene]);

  const handleAPI = useCallback((api: any) => {
    apiRef.current = api;
  }, []);

  const handleChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      elementsRef.current = [...elements];
      filesRef.current = files;
      if (!drawnRef.current && elements.length > 0) {
        drawnRef.current = true;
        onDraw?.();
      }
    },
    [onDraw],
  );

  const handleSave = useCallback(async () => {
    const { exportToBlob } = await import('@excalidraw/excalidraw');
    const activeElements = elementsRef.current.filter((el: any) => !el.isDeleted);
    const blob = await exportToBlob({
      elements: activeElements,
      appState: {
        viewBackgroundColor: bgColor,
        exportBackground: true,
        exportEmbedScene: true,
      },
      files: filesRef.current,
      exportPadding: 10,
    });
    if (blob) {
      const file = new File([blob], `drawing-${Date.now()}.png`, { type: 'image/png' });
      onSave(file);
    }
  }, [onSave, bgColor]);

  const excalidrawTheme = 'light' as const;

  return (
    <div className={isFullscreen ? 'fixed inset-0 z-[999] bg-black/40 flex items-center justify-center p-4' : ''}>
      <div className={`flex flex-col ${isFullscreen ? `w-full h-full max-w-[1200px] ${isDark ? 'bg-[#0D0D0D]' : 'bg-[#FAF7F2]'} ${roundedClass} overflow-hidden shadow-2xl` : 'gap-3'}`}>
        <div className={isFullscreen ? 'flex-1 min-h-0 p-3' : ''}>
          <div
            className={`relative border ${isDark ? 'border-white/10' : 'border-[#1a1a1a]/20'} ${roundedClass} overflow-hidden`}
            style={{ height: isFullscreen ? 'calc(100vh - 120px)' : 350 }}
          >
            <Excalidraw
              excalidrawAPI={handleAPI}
              initialData={{
                elements: initialScene?.elements || [],
                appState: {
                  viewBackgroundColor: bgColor,
                  ...initialScene?.appState,
                },
              }}
              onChange={handleChange}
              theme={excalidrawTheme}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  export: false,
                  saveToActiveFile: false,
                  changeViewBackgroundColor: false,
                },
                tools: { image: false },
              }}
              renderTopRightUI={() => null}
              isCollaborating={false}
            />
            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className={`absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center bg-[#1a1a1a]/10 hover:bg-[#1a1a1a]/20 text-[#1a1a1a] ${roundedClass} transition-colors`}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className={isFullscreen ? `shrink-0 px-4 py-3 border-t ${isDark ? 'border-white/10' : 'border-[#1a1a1a]/10'}` : ''}>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onCancel}
              className={`px-4 py-2 text-xs border ${isDark ? 'border-white/10 text-white/70 hover:text-white' : 'border-[#1a1a1a]/20 text-[#1a1a1a]/70 hover:text-[#1a1a1a]'} ${roundedClass} transition-colors`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className={`px-4 py-2 text-xs ${isDark ? 'bg-white text-[#0D0D0D] hover:bg-white/90' : 'bg-[#1a1a1a] text-white hover:bg-[#2a2a2a]'} ${roundedClass} transition-colors`}
            >
              Save drawing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { BG_COLORS };
