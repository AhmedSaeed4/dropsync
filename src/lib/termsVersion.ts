/**
 * The current Terms-of-Service version.
 *
 * SINGLE SOURCE OF TRUTH: this constant is used in TWO places that must never drift —
 *   1. the comparison that decides whether a user must re-accept
 *      (`users/{uid}.tosAcceptedVersion >= CURRENT_TERMS_VERSION`), and
 *   2. the accept-write that records the version the user agreed to
 *      (`{ tosAcceptedVersion: CURRENT_TERMS_VERSION }`).
 *
 * Bump this number whenever the Terms change in a way that requires every user to re-accept.
 * The clickwrap consent gate in src/app/page.tsx + src/components/TermsConsentGate.tsx reads it
 * from here so the gate and the write can't disagree.
 */
export const CURRENT_TERMS_VERSION = 3;
