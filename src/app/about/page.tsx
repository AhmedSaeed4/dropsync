'use client';
import dynamic from 'next/dynamic';

// Pre-paint the saved theme's body background BEFORE first paint so a cold load (new tab /
// refresh / direct URL) never shows the cream default. Reads the SAME localStorage keys + the
// SAME mapping as the body-bg useEffect in AboutClient — KEEP THEM IN SYNC (see hard rules).
const PREPAINT_BG = `(function(){try{var t=localStorage.getItem('dropsync_theme');var l=localStorage.getItem('dropsync_layout');var bg='#FFFEF5';if(t==='dark')bg='#0D0D0D';else if(t==='minimal')bg='#C5C9B8';else if(l==='classic')bg='#FAF7F2';document.body.style.background=bg;document.body.style.color=(t==='dark')?'#ffffff':'#1a1a1a';}catch(e){}})();`;

const AboutClient = dynamic(() => import('./AboutClient'), { ssr: false });

export default function AboutPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREPAINT_BG }} />
      <AboutClient />
    </>
  );
}
