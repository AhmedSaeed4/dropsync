/**
 * Single source of truth for the `/terms` page's legal sections.
 *
 * Both the classic and editorial layouts in `TermsClient` `.map()` over `sections`, so the
 * section text, order, and ids can NEVER drift between layouts — only styling/casing differs.
 *
 * The standalone "17. Contact" section is NOT here: it contains a `mailto:` link (JSX),
 * so the plain `paragraphs: string[]` shape can't hold it. It stays inline in `TermsClient` and
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
    id: "agreement",
    title: "1. Agreement to these Terms",
    paragraphs: [
      "By creating an account or using DropSync in any way, you enter into a binding agreement with the Operator on these Terms. If you do not accept them, you must not access or use DropSync. You also agree to our Privacy Policy, which explains how we handle your data.",
    ],
  },
  {
    id: "who-may-use",
    title: "2. Who may use DropSync",
    paragraphs: [
      "You may use DropSync only if you can form a legally binding contract under the laws that apply to you. In particular:",
    ],
    items: [
      { label: "Minimum age.", text: "You must be at least 13 years old (or 16 where your country requires a higher age). If you are under 18, you may use DropSync only with the involvement of a parent or legal guardian who agrees to these Terms on your behalf." },
      { label: "Accurate information.", text: "You must provide accurate, current information when creating your account and keep it updated." },
      { label: "Your account.", text: "You may have only one account per identity, and you are responsible for everything done through your account. Do not share your password or let others use it." },
      { label: "Where DropSync is offered.", text: "You may not use DropSync if you are legally barred from receiving the service, or from a location where it is not offered." },
    ],
  },
  {
    id: "your-account",
    title: "3. Your account",
    paragraphs: [
      "You are responsible for keeping your account secure and for all activity under it, including content you upload, shares you create, and messages you send. Protect your sign-in credentials and notify us promptly at ahmedsaeed20026@gmail.com if you believe your account has been accessed without permission. We are not liable for losses caused by credentials you failed to protect.",
    ],
  },
  {
    id: "your-content",
    title: "4. Your content and our license to operate",
    paragraphs: [
      "“Your Content” means the files, notes, drawings, images, messages, and anything else you create or upload to DropSync.",
    ],
    items: [
      { label: "You own it.", text: "You retain all of your rights in Your Content." },
      { label: "License you grant us.", text: "To operate DropSync for you, you grant the Operator a worldwide, non-exclusive, royalty-free license to host, store, transmit, process, index, decrypt, and display Your Content solely as needed to run the service and the features you use — including secure storage, sharing, workspace chat, and the AI assistant. This license ends when Your Content is deleted from DropSync." },
      { label: "Your responsibility.", text: "You must have the rights to everything you upload, and Your Content must not breach these Terms or anyone else’s rights. You are solely responsible for Your Content and for any consequences of sharing it." },
    ],
  },
  {
    id: "acceptable-use",
    title: "5. Acceptable use",
    paragraphs: [
      "You agree not to misuse DropSync or use it to harm others. You will not:",
    ],
    items: [
      { text: "Upload, share, or store content that is illegal, or that infringes someone else’s intellectual property, privacy, or other rights, or that you do not have the right to use." },
      { text: "Distribute malware, viruses, or any malicious, harmful, or deceptive code, or use DropSync to attack, probe, scan, or compromise any system or network." },
      { text: "Share content that is harassing, threatening, defamatory, obscene, or that promotes violence, hatred, self-harm, or harm to others." },
      { text: "Use DropSync to send spam, phishing, or unsolicited messages, or to distribute anything unlawfully." },
      { text: "Attempt to access, disrupt, overload, or circumvent the security of DropSync, reverse-engineer it, scrape it, or interfere with other users’ use of it." },
      { text: "Create share links to content you do not have the rights to distribute, or share content in a way that misleads or deceives recipients." },
      { text: "Use DropSync for any unlawful purpose, or in any way that could damage, disable, or bring DropSync into disrepute." },
    ],
  },
  {
    id: "sharing-storage",
    title: "6. File sharing and temporary storage",
    paragraphs: [
      "DropSync is built for temporary, user-controlled file sharing. You decide how long each “drop” is kept:",
    ],
    items: [
      { label: "Auto-expiry.", text: "Each drop expires after the lifetime you choose — 1 hour, 2 hours, 6 hours, or 24 hours — and is then deleted from our database and storage." },
      { label: "Forever drops.", text: "Drops set to “forever” are kept until you (or the workspace owner) delete them." },
      { label: "Share links are bearer secrets.", text: "Anyone who has a share link can open that shared content. You are responsible for who you give links to and for what you choose to share." },
      { label: "No guaranteed retention.", text: "We do not guarantee that the service will be uninterrupted or error-free, and we are not liable for the loss of content beyond the controls we provide. Keep your own copies of anything important." },
      { label: "Backups.", text: "If you export a .dropsync backup, the file is encrypted with a password you choose, and that password is known only to you — DropSync cannot recover or reset it. You are responsible for keeping the file and the password safe. We are not responsible for lost backups, or for archives that are corrupted, damaged, or can no longer be opened." },
    ],
  },
  {
    id: "security",
    title: "7. Security and encryption",
    paragraphs: [
      "Your data is encrypted in transit (HTTPS) and at rest. Content under 10 MB is encrypted in your browser before it leaves your device using AES-256-GCM; larger files are transmitted over HTTPS but stored without content encryption.",
      "This is not end-to-end or zero-knowledge encryption. The Operator can decrypt content when needed to operate the service, run the AI assistant, and provide support. Full details are in our Privacy Policy.",
    ],
  },
  {
    id: "ai-assistant",
    title: "8. AI assistant",
    paragraphs: [
      "When you ask the AI assistant to do something, it may decrypt and read the relevant drops to carry out your request. Drops in the “password” category are excluded — the assistant cannot read, search, list, or change them. See our Privacy Policy for more on automated processing.",
    ],
  },
  {
    id: "third-parties",
    title: "9. Third-party services and links",
    paragraphs: [
      "DropSync relies on third-party providers — such as hosting, storage, authentication, and AI providers — listed in our Privacy Policy. Content or links inside your drops may point to third-party sites and services that we do not control. We are not responsible for their content, practices, or availability.",
    ],
  },
  {
    id: "suspension",
    title: "10. Suspension and termination",
    paragraphs: [
      "You can delete your account at any time in Settings. Deletion removes your content; where a workspace is involved, ownership may transfer as described in our Privacy Policy.",
      "We may suspend or terminate your account, or remove content, if you breach these Terms, if you create risk or legal exposure for us, or if we reasonably believe it is necessary to protect the service, other users, or the law. When your account ends, your right to use DropSync ends too. Provisions that by their nature should survive — such as those on liability, licenses, and governing law — remain in effect.",
    ],
  },
  {
    id: "disclaimers",
    title: "11. Disclaimers",
    paragraphs: [
      "DropSync is provided “as is” and “as available.” To the fullest extent permitted by law, the Operator disclaims all warranties, whether express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the service will be uninterrupted, secure, or error-free, or that any content will be retained without loss.",
    ],
  },
  {
    id: "liability",
    title: "12. Limitation of liability",
    paragraphs: [
      "To the fullest extent permitted by law, in no event will the Operator be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, data, or goodwill, arising out of or related to DropSync — whether under contract, tort, or any other theory.",
      "Because DropSync is provided free of charge, the Operator’s total aggregate liability for any claim arising out of or related to these Terms or the service is limited to the amount you have paid the Operator for the service, which is zero (US$0). You acknowledge that DropSync is not a critical service and that you are responsible for keeping your own backups of anything important.",
    ],
  },
  {
    id: "indemnity",
    title: "13. Indemnity",
    paragraphs: [
      "To the fullest extent permitted by law, you agree to indemnify and hold the Operator harmless from any claims, damages, losses, and expenses (including reasonable legal fees) arising out of Your Content, your sharing of it, or your breach of these Terms.",
    ],
  },
  {
    id: "copyright",
    title: "14. Copyright and takedown",
    paragraphs: [
      "We respect intellectual property. If you believe content on DropSync infringes your copyright or other rights, send us a notice at ahmedsaeed20026@gmail.com that identifies the content and your rights. We will review valid notices and may remove the content or restrict repeat infringers’ access.",
    ],
  },
  {
    id: "governing-law",
    title: "15. Governing law and disputes",
    paragraphs: [
      "These Terms, and any dispute arising out of or relating to DropSync or these Terms, are governed by the laws of Pakistan, without regard to its conflict-of-law rules.",
      "You and the Operator agree to try to resolve any dispute informally first. Any dispute that cannot be resolved will be submitted to the exclusive jurisdiction of the courts of Pakistan.",
      "Nothing in these Terms reduces any mandatory consumer-protection rights you have under the laws of the country where you live.",
    ],
  },
  {
    id: "changes",
    title: "16. Changes to these Terms",
    paragraphs: [
      "We may update these Terms from time to time. The “Last updated” date above shows the most recent version. If we make material changes, we will note them on this page and, where appropriate, ask you to accept the updated Terms. If you continue to use DropSync after a change takes effect, you accept the revised Terms.",
    ],
  },
];
