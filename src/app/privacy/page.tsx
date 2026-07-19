import type { Metadata } from "next";
import PrivacyClient from "./PrivacyClient";

export const metadata: Metadata = {
  title: "Privacy Policy — DropSync",
  description:
    "How DropSync collects, uses, protects, and retains your data, and the choices you have.",
};

/**
 * Public, standalone Privacy Policy.
 *
 * Server component — keeps the route `metadata` + the parse-time PREPAINT, then mounts
 * `PrivacyClient` (which branches the classic vs editorial layout from localStorage, gated behind a
 * mounted flag so the server never SSRs the localStorage-driven tree — identical effect to
 * `dynamic(..., { ssr: false })`, which a Server Component cannot use in Next 16). Reachable
 * without login so the URL can be given to Firebase / linked publicly.
 *
 * The legal text lives in `./sections.ts` (single source for both layouts). It is best-effort
 * accurate to what the app actually does (verified against the codebase); it is NOT legal advice —
 * have a qualified lawyer review it before relying on it for compliance.
 *
 * Controller: Ahmed (based in Pakistan). Contact: ahmedsaeed20026@gmail.com.
 */

// COOKIE-FREE, layout-aware theme pre-paint. Reads BOTH `dropsync_theme` AND `dropsync_layout`
// during HTML parse (BEFORE first paint) and paints the correct background for the chosen layout
// (classic light #FAF7F2, editorial light #FFFEF5, shared dark #0D0D0D) so there is NO flash on a
// cold load in either layout. Also sets the editorial CSS custom properties the editorial tree
// consumes via Tailwind var() classes (the classic tree uses inline styles, so the vars are harmless
// there). Minimal collapses to light in both layouts (no sage on this page). Mirrors the body-bg
// useEffect in `PrivacyClient` — KEEP IN SYNC. (Vars set on document.body.style, NEVER documentElement —
// see layout.tsx suppressHydrationWarning.)
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var l=localStorage.getItem('dropsync_layout');var isDark=(t==='dark');var bg,text,muted,heading,border,link;if(isDark){bg='#0D0D0D';text='#ffffff';muted='#888';heading='#ffffff';border='#333';link='#ffffff';}else{bg='#FFFEF5';text='#1a1a1a';muted='#666';heading='#1a1a1a';border='#e0e0e0';link='#1a1a1a';}var r=document.body.style;r.setProperty('--bg',bg);r.setProperty('--text',text);r.setProperty('--muted',muted);r.setProperty('--heading',heading);r.setProperty('--border',border);r.setProperty('--link',link);var bodyBg;if(isDark){bodyBg='#0D0D0D';}else if(l==='classic'){bodyBg='#FAF7F2';}else{bodyBg='#FFFEF5';}r.background=bodyBg;r.color=isDark?'#ffffff':'#1a1a1a';}catch(e){}})();`;

export default function PrivacyPolicyPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <PrivacyClient />
    </>
  );
}
