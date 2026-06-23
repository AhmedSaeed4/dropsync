import { cookies } from 'next/headers';
import ShareClient from './ShareClient';

// Runs during HTML parse, BEFORE hydration: copies the app's `dropsync_theme` localStorage
// value into the `share-theme` cookie so the SERVER renders the right theme on the NEXT load
// (no flash from the second visit on, for users who set dark on the main app). It only sets a
// cookie for the next load — it never touches the current render, so there's no hydration
// mismatch. Only light/dark are synced; minimal (app-only) falls back to light.
const SYNC_THEME = `(function(){try{var t=localStorage.getItem('dropsync_theme');if(t==='dark'||t==='light'){document.cookie='share-theme='+t+';path=/;max-age=31536000;SameSite=Lax';}}catch(e){}})();`;

export default async function SharePage() {
  // The cookie is set by the toggle (live) and by the SYNC_THEME script (from the app's
  // localStorage). Reading it here lets the SERVER paint the user's real theme at first
  // paint — no light-first-paint flash for dark users. No cookie yet → safe 'light' default.
  const c = await cookies();
  const t = c.get('share-theme')?.value;
  const initialTheme: 'light' | 'dark' = t === 'light' ? 'light' : 'dark';

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SYNC_THEME }} />
      <ShareClient initialTheme={initialTheme} />
    </>
  );
}
