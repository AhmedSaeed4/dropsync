'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { contentToPlainText } from '@/lib/dropTagUtils';

interface ShareData {
  type: 'text' | 'file';
  name: string;
  content: string | null;
  mimeType: string | null;
  fileSize: number | null;
  imageUrl: string | null;
  fileUrl: string | null;
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
  const [videoSrc, setVideoSrc] = useState<string | null>(null);

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

  useEffect(() => {
    if (!share?.fileUrl || !share.mimeType?.startsWith('video/')) return;
    let cancelled = false;
    let blobUrl: string | null = null;

    fetch(share.fileUrl)
      .then(res => res.text())
      .then(text => {
        if (cancelled) return;
        if (text.startsWith('data:')) {
          return fetch(text).then(r => r.blob());
        }
        return new Blob([text], { type: share.mimeType || 'video/mp4' });
      })
      .then(blob => {
        if (!cancelled && blob) {
          blobUrl = URL.createObjectURL(blob);
          setVideoSrc(blobUrl);
        }
      })
      .catch(() => { if (!cancelled) setVideoSrc(null); });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [share?.fileUrl, share?.mimeType]);

  const handleCopy = async () => {
    if (share?.content) {
      // Copy the same clean text the viewer sees (mentions as plain names), not the raw tokens.
      await navigator.clipboard.writeText(contentToPlainText(share.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async () => {
    const url = share?.imageUrl || share?.fileUrl;
    if (!url) return;
    try {
      const res = await fetch(url);
      const text = await res.text();
      let blob: Blob;
      if (text.startsWith('data:')) {
        const dataRes = await fetch(text);
        blob = await dataRes.blob();
      } else {
        blob = new Blob([text], { type: share?.mimeType || 'application/octet-stream' });
      }
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = share?.name || 'download';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(url, '_blank');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFFEF5] flex flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <span className="text-[22px] text-[#1a1a1a] font-medium tracking-[-0.3px]">
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </span>
          <div className="w-5 h-5 border border-[#1a1a1a]/30 border-t-[#1a1a1a] animate-spin rounded-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFFEF5] flex flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center gap-3">
          <span className="text-[22px] text-[#1a1a1a] font-medium tracking-[-0.3px]">
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </span>
          <div className="w-10 h-10 rounded-lg border border-[#e0e0e0] flex items-center justify-center mt-4">
            <svg className="w-5 h-5 text-[#666]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <p className="text-sm text-[#1a1a1a] font-medium mt-2">
            {error === 'expired' ? 'No longer available' : 'Something went wrong'}
          </p>
          <p className="text-xs text-[#666] text-center max-w-sm">
            {error === 'expired'
              ? 'This file has expired or been removed by the owner.'
              : 'We couldn\'t load this shared file. Please try again later.'}
          </p>
        </div>
      </div>
    );
  }

  if (!share) return null;

  const isVideo = share.mimeType?.startsWith('video/');
  const hasFileUrl = !!share.fileUrl;

  return (
    <div className="min-h-screen bg-[#FFFEF5] flex flex-col">
      {/* Header */}
      <header className="border-b border-[#e0e0e0] px-6 py-5 flex items-center justify-between">
        <span className="text-[22px] text-[#1a1a1a] font-medium tracking-[-0.3px]">
          <span className="inline-block mr-2 text-lg">&#9670;</span>
          DropSync
        </span>
        <span className="text-[11px] text-[#666] tracking-wider">
          Shared file
        </span>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-3xl">
          {/* File name */}
          <p className="text-[11px] text-[#666] tracking-wider mb-2">
            {share.type === 'text' ? 'Text note' : isVideo ? 'Video' : share.mimeType || 'File'}
          </p>
          <h1 className="text-xl text-[#1a1a1a] font-medium tracking-[-0.3px] mb-6">
            {share.name}
          </h1>

          {/* YouTube thumbnail */}
          {share.youtubeVideoId && (
            <div className="mb-6">
              <a
                href={`https://www.youtube.com/watch?v=${share.youtubeVideoId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-lg border border-[#e0e0e0] overflow-hidden hover:opacity-90 transition-opacity"
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
            <div className="rounded-lg border border-[#e0e0e0] bg-white p-6 mb-6">
              <pre className="text-sm text-[#1a1a1a] whitespace-pre-wrap break-all leading-relaxed">
                {contentToPlainText(share.content)}
              </pre>
            </div>
          )}

          {/* Attached image */}
          {share.imageUrl && (
            <div className="flex items-center justify-center mb-6">
              <img
                src={share.imageUrl}
                alt="Attached image"
                className="max-w-full max-h-[50vh] rounded-lg border border-[#e0e0e0] object-contain"
              />
            </div>
          )}

          {/* Video player */}
          {isVideo && share.fileUrl && (
            <div className="flex items-center justify-center mb-6 rounded-lg border border-[#e0e0e0] bg-white overflow-hidden aspect-video">
              {videoSrc ? (
                <video
                  src={videoSrc}
                  controls
                  className="max-w-full max-h-[60vh]"
                >
                  Your browser does not support video playback.
                </video>
              ) : (
                <div className="flex items-center justify-center w-full h-full">
                  <div className="w-8 h-8 text-[#666] animate-pulse">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Generic file drop */}
          {hasFileUrl && !isVideo && !share.imageUrl && (
            <div className="flex flex-col items-center justify-center rounded-lg border border-[#e0e0e0] bg-white p-10 mb-6">
              <svg className="w-10 h-10 text-[#666] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <p className="text-xs text-[#666]">
                {share.mimeType || 'File'}
              </p>
              {share.fileSize && (
                <p className="text-[11px] text-[#999] mt-1">
                  {(share.fileSize / (1024 * 1024)).toFixed(1)} MB
                </p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 mt-2">
            {share.type === 'text' && share.content && (
              <button
                onClick={handleCopy}
                className="rounded-lg border border-[#1a1a1a] text-[#1a1a1a] px-5 py-2.5 text-xs tracking-wide hover:bg-[#1a1a1a] hover:text-white transition-colors flex items-center gap-2"
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            {(share.imageUrl || hasFileUrl) && (
              <button
                onClick={handleDownload}
                className="rounded-lg bg-[#1a1a1a] text-white px-5 py-2.5 text-xs tracking-wide hover:bg-[#333] transition-colors flex items-center gap-2"
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
                className="rounded-lg border border-[#FF0000] text-[#FF0000] px-5 py-2.5 text-xs tracking-wide hover:bg-[#FF0000] hover:text-white transition-colors flex items-center gap-2"
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
      <footer className="border-t border-[#e0e0e0] px-6 py-4 text-center">
        <a
          href="/"
          className="text-xs text-[#999] hover:text-[#1a1a1a] transition-colors"
        >
          Shared via DropSync
        </a>
      </footer>
    </div>
  );
}
