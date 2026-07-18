import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — DropSync",
  description:
    "How DropSync collects, uses, protects, and retains your data, and the choices you have.",
};

/**
 * Public, standalone Privacy Policy.
 *
 * Server component — no client JS, no in-app theme coupling, reachable without login
 * so the URL can be given to Firebase / linked publicly.
 *
 * The policy text below is best-effort accurate to what the app actually does
 * (verified against the codebase). It is NOT legal advice; have a qualified lawyer
 * review it before relying on it for compliance.
 *
 * Controller: Ahmed (based in Pakistan). Contact: ahmedsaeed20026@gmail.com.
 */

type Section = {
  id: string;
  title: string;
  /** Prose paragraphs. */
  paragraphs?: string[];
  /** Bulleted list items. `label` (optional) renders bold before the text. */
  items?: { label?: string; text: string }[];
};

const LAST_UPDATED = "July 18, 2026";

// COOKIE-FREE theme pre-paint. Reads the app's `dropsync_theme` localStorage value during
// HTML parse (BEFORE first paint) and sets this page's editorial CSS vars + body bg/color on
// document.body.style, so /privacy follows the app theme with NO cookie and NO flash. Mirrors
// src/app/docs/page.tsx's PREPAINT (vars on document.body.style, NEVER documentElement — see
// layout.tsx suppressHydrationWarning). Same collapse rule the cookie read used: dark → dark,
// everything else (light/minimal/missing) → light. Palette tokens are byte-identical to the old
// server-side buildThemeStyle output, so appearance is unchanged — only the theme SOURCE moved
// (cookie → localStorage).
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var bg,text,muted,heading,border,link;if(t==='dark'){bg='#0D0D0D';text='#ffffff';muted='#888';heading='#ffffff';border='#333';link='#ffffff';}else{bg='#FFFEF5';text='#1a1a1a';muted='#666';heading='#1a1a1a';border='#e0e0e0';link='#1a1a1a';}var r=document.body.style;r.setProperty('--bg',bg);r.setProperty('--text',text);r.setProperty('--muted',muted);r.setProperty('--heading',heading);r.setProperty('--border',border);r.setProperty('--link',link);r.background=bg;r.color=text;}catch(e){}})();`;

const sections: Section[] = [
  {
    id: "what-data",
    title: "1. What data we collect",
    paragraphs: [
      "We only collect what is needed to run DropSync. Specifically:",
    ],
    items: [
      {
        label: "Account data.",
        text: "When you create an account (Google Sign-In or email and password), we store your email address, display name, profile photo (only if you sign in with Google), the sign-in method you used, account-creation and last-active timestamps, and sign-in activity recorded by our authentication provider. We also store your in-app preferences (such as category-collapse and drop sort/order settings) on your account.",
      },
      {
        label: "Content you create.",
        text: "Text notes, uploaded files (up to 500 MB each), images and drawings you attach, workspace names and memberships, categories, share links, workspace chat messages, and your conversations with the AI assistant.",
      },
      {
        label: "Audio for transcription.",
        text: "When you use voice-to-text, the audio you record is sent for transcription (see “Third parties”).",
      },
      {
        label: "Operational data.",
        text: "Basic technical data generated while running the service (for example request and error logs), held by our hosting and infrastructure providers. We keep this to a minimum.",
      },
    ],
  },
  {
    id: "how-why",
    title: "2. How and why we use your data",
    paragraphs: [
      "We use your data only to operate and improve DropSync — for no other purpose. We do not sell, rent, or share it with anyone for their own use, and we do not use your content to train AI models. Our AI providers process your data only to handle your requests, not to train their models.",
      "The legal bases on which we process your data (under the EU/UK GDPR, Article 6) are:",
    ],
    items: [
      {
        label: "Providing the service — contract (Art. 6(1)(b)).",
        text: "Running your account and the file-sharing, workspace, and chat features you signed up for.",
      },
      {
        label: "The AI assistant — contract / legitimate interest (Art. 6(1)(b)/(f)).",
        text: "When you ask the assistant to do something, it decrypts and reads the relevant drops to answer your request.",
      },
      {
        label: "Voice transcription — consent / contract.",
        text: "Transcribing audio only when you actively request it.",
      },
      {
        label: "Security and reliability — legitimate interest (Art. 6(1)(f)).",
        text: "Preventing abuse, keeping the service running, and fixing problems.",
      },
      {
        label: "Legal obligations — legal obligation (Art. 6(1)(c)).",
        text: "Responding to lawful requests where we are required to.",
      },
    ],
  },
  {
    id: "encryption-security",
    title: "3. Encryption and security",
    paragraphs: [
      "Your data is encrypted in transit over HTTPS. Text notes, files under 10 MB, images, drawings, and workspace chat messages are encrypted in your browser before they leave your device, using AES-256-GCM.",
      "Files larger than 10 MB are stored without content encryption (they are still transmitted over HTTPS). This is a deliberate limit so that large uploads work reliably.",
      "Important — this is not “end-to-end” or “zero-knowledge” encryption. To enable features like the AI assistant and access to your drops from any device you sign in on, the encryption keys are generated in your browser and also stored with your account. Because we hold those keys, we are able to decrypt your content when needed to operate the service, run the AI assistant, and provide support. Do not store anything in DropSync expecting that no one but you could ever read it.",
      "Encryption keys are generated locally with the Web Crypto API and held in IndexedDB on your device, with a backup stored with your account so you can reach your data from other devices.",
      "Drops in the “password” category are excluded from the AI assistant: it cannot read, search, list, or change them. It may report a count of how many exist, but never their contents. No security measure is perfect; see “Your rights” for how to delete your data.",
    ],
  },
  {
    id: "third-parties",
    title: "4. Third parties (subprocessors)",
    paragraphs: [
      "We use the following third-party providers to run DropSync. Each processes data only as needed to deliver the service.",
    ],
    items: [
      {
        label: "Google Firebase (Authentication + Firestore) — USA.",
        text: "Accounts and the app database.",
      },
      {
        label: "Cloudflare R2 — USA / global.",
        text: "File and image storage.",
      },
      {
        label: "Vercel — USA / global.",
        text: "Web hosting for the app.",
      },
      {
        label: "A third-party backend hosting provider — location per provider.",
        text: "Runs the AI assistant backend. To answer your requests, it processes your chat messages, decrypts the relevant drops, and sends them to the model provider.",
      },
      {
        label: "Groq — USA.",
        text: "Runs the AI model (gpt-oss-120b) that powers the assistant, and provides voice-to-text transcription (Whisper).",
      },
      {
        label: "OpenAI — USA.",
        text: "Agent observability and tracing (telemetry about how the assistant runs).",
      },
    ],
  },
  {
    id: "transfers",
    title: "5. International data transfers",
    paragraphs: [
      "Your data is processed in the United States (Google Firebase, Cloudflare R2, Vercel, Groq, and OpenAI). The AI assistant backend runs in the region of its hosting provider.",
      "Where data is transferred from the EU/UK/EEA, we rely on the EU-US Data Privacy Framework for US providers that participate in it, and on Standard Contractual Clauses (or other lawful transfer mechanisms) where applicable. We do not knowingly offer the service where doing so would be unlawful.",
    ],
  },
  {
    id: "cookies",
    title: "6. Cookies and local storage",
    paragraphs: [
      "DropSync does not use cookies to track you. We do not set analytics, advertising, cross-site, or social-media cookies, and we do not use third-party tracking or advertising scripts.",
      "We do use your browser's local storage — a small on-device store that is never sent to our servers — to remember your preferences, such as your light/dark theme, your layout, and the workspace you last opened. This information stays on your device, under your control, and you can clear it at any time through your browser's settings.",
      "If you open a preview of a drop that links to a third-party service such as YouTube, that service's embedded player is loaded in its privacy-enhanced mode where available. It may still set its own cookies if you interact with it; those are governed by that service's own privacy policy, not DropSync.",
      "Your browser's standard controls for cookies and site data apply in all cases.",
    ],
  },
  {
    id: "ai-processing",
    title: "7. AI and automated processing",
    paragraphs: [
      "We do not use solely-automated decision-making or profiling that produces legal or similarly significant effects about you. The AI assistant processes your content only to carry out your explicit requests — for example summarizing, searching, creating, or organizing drops. If you have a concern about any automated processing, contact us.",
    ],
  },
  {
    id: "retention",
    title: "8. Data retention",
    paragraphs: [
      "You choose how long each drop lives: 1 hour, 2 hours, 6 hours, 24 hours, or “forever”. When a drop expires, it is deleted from the database and its file and image are deleted from storage. “Forever” drops are kept until you (or a workspace owner) delete them.",
      "Account data is kept until you delete your account. Voice audio and AI requests are transient: they are not retained by us, and we have enabled Zero Data Retention with our AI provider (Groq) so they are not stored by that provider either. Other provider-side backups and logs may persist briefly as part of normal operations; we keep these to a minimum.",
    ],
  },
  {
    id: "your-rights",
    title: "9. Your rights",
    paragraphs: [
      "Depending on where you live, you may have the right to: access the personal data we hold about you; correct inaccurate data; delete your data (you can delete your account and its content at any time in Settings); receive a portable copy of your data; object to certain processing; and, where we rely on consent, withdraw it.",
      "If you are a California resident (CCPA/CPRA), you have the right to know, delete, correct, opt out of the “sale” or “sharing” of personal information, and limit the use of sensitive personal information.",
      "We do not sell your personal information, and we do not share it for cross-context advertising.",
      "To exercise any right, contact us at ahmedsaeed20026@gmail.com.",
    ],
  },
  {
    id: "children",
    title: "10. Children",
    paragraphs: [
      "DropSync is not directed to anyone under 13 (or under 16 where local law requires). If you are under that age, please do not use the service. If you believe a child has given us their data, contact us and we will delete it.",
    ],
  },
  {
    id: "changes",
    title: "11. Changes to this policy",
    paragraphs: [
      "We may update this Privacy Policy. The “Last updated” date above reflects the most recent version. Material changes will be noted here, so please check back periodically.",
    ],
  },
];

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <article className="mx-auto max-w-2xl rounded-lg px-6 py-16 sm:py-20">
        {/* Header / logo */}
        <header className="mb-10">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[var(--link)]"
          >
            <span className="text-xl leading-none" aria-hidden>
              ◆
            </span>
            <span className="text-base font-semibold tracking-tight font-[family-name:var(--font-raleway)]">DropSync</span>
          </Link>
          <h1 className="mt-8 text-3xl font-bold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        {/* Intro */}
        <p className="text-[15px] leading-7 text-[var(--text)]">
          This Privacy Policy explains what DropSync collects, why, how it is protected,
          and the choices you have. DropSync is operated by Ahmed, based in Pakistan, who
          is the data controller responsible for your personal data under the EU/UK GDPR
          and other applicable privacy laws. For any privacy question, request, or
          complaint, contact us at{" "}
          <a
            href="mailto:ahmedsaeed20026@gmail.com"
            className="text-[var(--link)] underline hover:opacity-70 transition-opacity"
          >
            ahmedsaeed20026@gmail.com
          </a>
          .
        </p>

        {/* Sections */}
        {sections.map((section) => (
          <section key={section.id} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
              {section.title}
            </h2>

            {section.paragraphs?.map((para, i) => (
              <p key={i} className="mt-4 text-[15px] leading-7 text-[var(--text)]">
                {para}
              </p>
            ))}

            {section.items && (
              <ul className="mt-4 space-y-3">
                {section.items.map((item, i) => (
                  <li
                    key={i}
                    className="text-[15px] leading-7 text-[var(--text)]"
                  >
                    {item.label && (
                      <span className="font-semibold text-[var(--heading)]">
                        {item.label}{" "}
                      </span>
                    )}
                    {item.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        {/* 12. Contact — explicit so the email renders as a clickable mailto link */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
            12. Contact
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-[var(--text)]">
            For privacy questions, requests, or complaints, contact us at{" "}
            <a
              href="mailto:ahmedsaeed20026@gmail.com"
              className="text-[var(--link)] underline hover:opacity-70 transition-opacity"
            >
              ahmedsaeed20026@gmail.com
            </a>
            . We aim to respond within a reasonable time and within any period required
            by law.
          </p>
        </section>

        {/* Footer */}
        <footer className="mt-16 border-t border-[var(--border)] pt-8">
          <p className="text-sm text-[var(--muted)]">
            © {new Date().getFullYear()} DropSync. This page is provided for
            informational purposes.
          </p>
          <p className="mt-2">
            <Link
              href="/"
              className="text-sm text-[var(--link)] underline hover:opacity-70 transition-opacity"
            >
              ← Back to DropSync
            </Link>
          </p>
        </footer>
      </article>
    </main>
  );
}
