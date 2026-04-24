'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface ShareData {
  type: 'text' | 'file';
  name: string;
  content: string | null;
  mimeType: string | null;
  fileSize: number | null;
  imageUrl: string | null;
  youtubeVideoId: string | null;
  expiresAt: string | null;
}

export default function SharePage() {
  const params = useParams();
  const shareId = params.shareId as string;
  const [share, setShare] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchShare() {
      try {
        const res = await fetch(`/api/share?id=${shareId}`);
        if (!res.ok) {
          if (res.status === 410 || res.status === 404) {
            setError('expired');
          } else {
            setError('error');
          }
          return;
        }
        const data = await res.json();
        setShare(data);
      } catch {
        setError('error');
      } finally {
        setLoading(false);
      }
    }
    fetchShare();
  }, [shareId]);

  const handleCopy = async () => {
    if (share?.content) {
      await navigator.clipboard.writeText(share.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (share?.imageUrl) {
      const link = document.createElement('a');
      link.href = share.imageUrl;
      link.download = share.name || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FAF7F2] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#1A1A1A] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#FAF7F2] flex flex-col items-center justify-center px-6">
        <div className="w-16 h-16 border border-[#1A1A1A]/20 flex items-center justify-center mb-6">
          <svg className="w-8 h-8 text-[#1A1A1A]/30" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold uppercase tracking-wider text-[#1A1A1A] mb-2">
          {error === 'expired' ? 'No longer available' : 'Something went wrong'}
        </h1>
        <p className="text-sm text-[#1A1A1A]/50 font-mono text-center">
          {error === 'expired'
            ? 'This file has expired or been removed by the owner.'
            : 'We couldn\'t load this shared file. Please try again later.'}
        </p>
        <div className="mt-12 text-xs text-[#1A1A1A]/30 font-mono uppercase tracking-wider">
          Shared via DropSync
        </div>
      </div>
    );
  }

  if (!share) return null;

  return (
    <div className="min-h-screen bg-[#FAF7F2] flex flex-col">
      {/* Header */}
      <header className="border-b border-[#1A1A1A] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#1A1A1A] flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <span className="text-xs font-mono uppercase tracking-wider text-[#1A1A1A]">
            DropSync
          </span>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#1A1A1A]/50">
          Shared file
        </span>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-3xl">
          {/* File name */}
          <h1 className="text-sm font-bold uppercase tracking-wider text-[#1A1A1A] mb-4">
            {share.name}
          </h1>

          {/* YouTube thumbnail */}
          {share.youtubeVideoId && (
            <div className="mb-4">
              <a
                href={`https://www.youtube.com/watch?v=${share.youtubeVideoId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block border border-[#1A1A1A] overflow-hidden hover:opacity-90 transition-opacity"
              >
                <img
                  src={`https://img.youtube.com/vi/${share.youtubeVideoId}/mqdefault.jpg`}
                  alt="YouTube thumbnail"
                  className="w-full h-auto"
                />
              </a>
            </div>
          )}

          {/* Text content */}
          {share.type === 'text' && share.content && (
            <div className="border border-[#1A1A1A] bg-[#F5F2ED] p-6 mb-4">
              <pre className="text-sm font-mono text-[#1A1A1A] whitespace-pre-wrap break-all">
                {share.content}
              </pre>
            </div>
          )}

          {/* Attached image */}
          {share.imageUrl && (
            <div className="flex items-center justify-center mb-4">
              <img
                src={share.imageUrl}
                alt="Attached image"
                className="max-w-full max-h-[50vh] border border-[#1A1A1A] object-contain"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 mt-6">
            {share.type === 'text' && share.content && (
              <button
                onClick={handleCopy}
                className="border border-[#1A1A1A] text-[#1A1A1A] px-5 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2"
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4 text-[#FF5A47]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </>
                )}
              </button>
            )}
            {share.imageUrl && (
              <button
                onClick={handleDownload}
                className="bg-[#1A1A1A] text-white px-5 py-2 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download
              </button>
            )}
            {share.youtubeVideoId && (
              <a
                href={`https://www.youtube.com/watch?v=${share.youtubeVideoId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-[#FF0000] text-[#FF0000] px-5 py-2 text-xs tracking-wider hover:bg-[#FF0000] hover:text-white transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                </svg>
                Watch on YouTube
              </a>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1A1A1A]/10 px-6 py-4 text-center">
        <a
          href="/"
          className="text-xs text-[#1A1A1A]/30 font-mono uppercase tracking-wider hover:text-[#1A1A1A]/60 transition-colors"
        >
          Shared via DropSync
        </a>
      </footer>
    </div>
  );
}
