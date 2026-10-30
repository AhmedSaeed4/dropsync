'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { mountLanding } from './landingRuntime';
import './landing.css';

interface LandingProps {
  onSignIn: (email: string, password: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  onSignUp: (email: string, password: string) => Promise<{ error?: string; success?: boolean }>;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onGoogleSignIn: () => Promise<void>;
  onShowVerifyModal: (email: string) => void;
  declineNote?: ReactNode;
}

export function Landing(props: LandingProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handlersRef = useRef(props);
  const { declineNote } = props;

  useLayoutEffect(() => { handlersRef.current = props; });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return mountLanding(root, {
      signIn: (email: string, password: string) => handlersRef.current.onSignIn(email, password),
      signUp: (email: string, password: string) => handlersRef.current.onSignUp(email, password),
      resetPassword: (email: string) => handlersRef.current.onResetPassword(email),
      google: () => handlersRef.current.onGoogleSignIn(),
      showVerification: (email: string) => handlersRef.current.onShowVerifyModal(email),
    });
  }, []);

  return (
    <div ref={rootRef} data-dropsync-landing data-view="b" data-lenis-prevent>
      <div className="landing-entry">
        <div className="shell">
          <header className="site-header">
            <span className="site-brand"><span className="diamond" aria-hidden="true"></span>DropSync</span>
            <button className="back-button" id="backToLanding" type="button"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5m5-5-5 5 5 5"/></svg>Back to home</button>
            <span className="header-note">YOUR SPACE, EVERYWHERE.</span>
          </header>
          <main className="content">
            <section className="art-column" aria-label="DropSync visual">
              <div className="art-stage" role="img" aria-label="An abstract sculpture of floating file sheets and a continuous loop, rendered in 3D. Move the pointer over the artwork to gently turn it.">
                <canvas id="artCanvas" aria-hidden="true"></canvas>
                <div className="fallback-art" id="fallbackArt" role="status" hidden>The 3D preview needs WebGL. Try a browser with hardware acceleration enabled.</div>
              </div>
              <div className="art-caption">
                <h2>A little less to carry.</h2>
                <p>Your files, links and ideas. Ready wherever the day takes you.</p>
              </div>
            </section>
            <section className="pitch" aria-labelledby="pitchTitle">
              <div className="pitch-inner">
                <div className="pitch-heading">
                <svg className="folder-mark" viewBox="0 0 320 123" role="img" aria-label="DropSync folder wordmark">
                  <defs>
                    <linearGradient id="folderInk" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="var(--landing-folder-start, #383b3c)"/>
                      <stop offset=".48" stopColor="var(--landing-folder-mid, #202324)"/>
                      <stop offset="1" stopColor="var(--landing-folder-end, #292c2d)"/>
                    </linearGradient>
                    <radialGradient id="folderGlow" cx=".2" cy="0" r=".9">
                      <stop offset="0" stopColor="#ffffff" stopOpacity=".065"/>
                      <stop offset="1" stopColor="#ffffff" stopOpacity="0"/>
                    </radialGradient>
                  </defs>
                  <path d="M0 0H121C146 0 149 35 189 35H302Q320 35 320 53V123H0Z" fill="url(#folderInk)"/>
                  <path d="M0 0H121C146 0 149 35 189 35H302Q320 35 320 53V123H0Z" fill="url(#folderGlow)"/>
                  <g fill="var(--landing-folder-label, #FFFEF5)" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" letterSpacing="-1.8">
                    <text x="5" y="41" fontSize="44">DROP</text>
                    <text x="315" y="114" fontSize="44" textAnchor="end">SYNC</text>
                  </g>
                  <path d="M299 49.5 305.5 56 299 62.5 292.5 56Z" fill="var(--landing-folder-label, #FFFEF5)"/>
                </svg>
                <p className="pitch-kicker">YOUR PERSONAL WORKSPACE</p>
                <h2 id="pitchTitle">A little less to carry.</h2>
                </div>
                <ul className="purpose-list" aria-label="Your space for">
                  <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19.5v-14A2 2 0 0 1 6 3.5Z"/><path d="M14 3.5v4h4M8 12h6M8 15.5h6"/></svg><span>Files</span></li>
                  <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 14.5 5-5"/><path d="M10.5 7.5 12 6a4 4 0 0 1 5.7 5.7l-2.2 2.2a4 4 0 0 1-5.7 0"/><path d="M13.5 16.5 12 18a4 4 0 0 1-5.7-5.7l2.2-2.2a4 4 0 0 1 5.7 0"/></svg><span>Links</span></li>
                  <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5h6M10 20h4"/><path d="M8.8 14.4a6 6 0 1 1 6.4 0c-.8.6-1.2 1.2-1.2 2.1h-4c0-.9-.4-1.5-1.2-2.1Z"/></svg><span>Ideas</span></li>
                </ul>
                <div className="entry-actions">
                  <button id="openAuth" className="entry-button" type="button"><span>Sign in</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></button>
                  <button id="openSignup" className="signup-entry" type="button">Create an account</button>
                </div>
              </div>
            </section>
            <section className="auth" aria-label="Account access">
              <div className="auth-top"><p className="account-switch"><span id="switchPrompt">New to DropSync?</span><button className="text-button switch-button" id="switchBtn" type="button"><span id="switchLabel">Create an account</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13 13 3M3 3h10v10"/></svg></button></p></div>
              <div className="card">
                {declineNote}
                <div className="card-heading">
                  <p className="eyebrow auth-eyebrow"><span className="small-diamond" aria-hidden="true"></span>YOUR PERSONAL WORKSPACE</p>
                  <h1 id="authTitle">Good to have<br />you back.</h1>
                  <p className="sub" id="authSub">Your things are right where you left them.</p>
                </div>
                <button className="google" id="googleBtn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.7 4.7 0 0 1-2 3 6.4 6.4 0 0 1-3.5.9c-2.6 0-4.9-1.8-5.7-4.2a6 6 0 0 1 0-3.6C7.1 7.8 9.4 6 12 6c1.5 0 2.9.5 4 1.5l3-3A9.6 9.6 0 0 0 12 2a10 10 0 1 0 0 20c2.7 0 5-.9 6.7-2.4 1.9-1.8 3.1-4.3 3.1-7.4Z"/></svg><span>Continue with Google</span></button>
                <div className="divider"><span>or continue with email</span></div>
                <form id="authForm">
                  <div className="field">
                    <div className="label-row"><label htmlFor="email">Email address</label></div>
                    <input id="email" name="email" type="email" placeholder="you@example.com" autoComplete="email" autoCapitalize="none" spellCheck={false} required />
                  </div>
                  <div className="field" id="passwordField">
                    <div className="label-row"><label htmlFor="password">Password</label><button className="text-button" id="forgotBtn" type="button">Forgot password?</button></div>
                    <div className="input-wrap">
                      <input id="password" name="password" type="password" placeholder="Enter your password" autoComplete="current-password" required />
                      <button className="eye" id="togglePassword" type="button" aria-label="Show password" aria-pressed={false}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path className="eye-slash" d="m4 3 16 18"/></svg></button>
                    </div>
                  </div>
                  <button className="submit" id="submitBtn" type="submit"><span id="submitLabel">Sign in to your space</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></button>
                </form>
                <p className="status" id="authStatus" role="status" aria-live="polite"></p>
                <p className="fine">By continuing, you agree to our <Link href="/terms">Terms</Link><br />and <Link href="/privacy">Privacy Policy</Link>.</p>
              </div>
              <footer className="auth-footer">
                <span className="auth-bottom"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7"/></svg>A little more peace of mind.</span>
                <nav className="footer-links" aria-label="Support and privacy"><Link href="/privacy">Privacy</Link><Link href="/docs">Help<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 12 8-8M4 4h8v8"/></svg></Link></nav>
              </footer>
            </section>
          </main>
          <footer className="site-footer">
            <nav className="site-links" aria-label="Legal and support">
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/docs">Help</Link>
              <Link href="/about">About</Link>
            </nav>
            <span className="footer-caption">A little more room to think.</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
