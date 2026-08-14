/**
 * Single source of truth for the `/privacy` page's legal sections.
 *
 * Both the classic and editorial layouts in `PrivacyClient` `.map()` over `sections`, so the
 * section text, order, and ids can NEVER drift between layouts — only styling/casing differs.
 *
 * The standalone "12. Contact" section is NOT here: it contains a `mailto:` link (JSX),
 * so the plain `paragraphs: string[]` shape can't hold it. It stays inline in `PrivacyClient` and
 * is rendered in BOTH layouts (invariant #6). Mirror of `src/app/docs/sections.ts`'s single-source
 * pattern.
 */
export type Section = {
  id: string;
  title: string;
  /** Prose paragraphs. */
  paragraphs?: string[];
  /** Bulleted list items. `label` (optional) renders bold before the text. */
  items?: { label?: string; text: string }[];
};

export const LAST_UPDATED = "August 14, 2026";

export const sections: Section[] = [
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
      "We use your data only to operate and improve DropSync — for no other purpose. We do not sell, rent, or share it with anyone for their own use. DropSync itself does not use your content to train AI models. However, our AI chat assistant is powered by a third-party model — currently Google Gemini on its free tier. When you use the assistant, your message and the relevant (non-password) drop content are sent to Google to generate a response, and under the free tier Google may use that data to improve its own services, which can include training its models. Drops in the “password” category are never sent to the AI provider. Voice-to-text clips are transcribed separately by Groq and are not used for training.",
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
      "If you export a backup, the .dropsync file is downloaded to your device and encrypted with a password only you know. DropSync does not store your backup files on its servers and has no access to their passwords.",
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
        label: "Google (Gemini) — USA.",
        text: "Powers the AI chat assistant. The backend is provider-switchable; the live model is shown at its /health endpoint. Under the free tier we use, Google may use the data sent to it to improve its services (see “How and why we use your data” above).",
      },
      {
        label: "Groq — USA.",
        text: "Provides voice-to-text transcription (Whisper) for voice clips. Groq does not use your voice audio to train its models.",
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
      "Your data is processed in the United States (Google Firebase, Google Gemini, Cloudflare R2, Vercel, Groq, and OpenAI). The AI assistant backend runs in the region of its hosting provider.",
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
      "Account data is kept until you delete your account. Your AI conversation history is kept so you can refer back to it; voice audio is not stored after transcription. Because the chat assistant runs on Google Gemini's free tier, Google may retain and use the data you send to the assistant (your messages and the relevant decrypted drop content) to improve its services, including training its models. Voice-to-text audio is sent to Groq for transcription; Groq does not use it for training. Other provider-side backups and logs may persist briefly as part of normal operations; we keep these to a minimum.",
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
