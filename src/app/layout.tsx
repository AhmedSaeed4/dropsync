import type { Metadata, Viewport } from "next";
import { Inter, Raleway } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const raleway = Raleway({
  subsets: ["latin"],
  variable: "--font-raleway",
});

// Real production origin for resolving relative metadata URLs (og:image etc.). This is a static
// export so it can't read request headers — the share page's generateMetadata derives its origin
// dynamically from the request instead (correct on prod, preview deploys, and custom domains).
export const metadata: Metadata = {
  metadataBase: new URL("https://drag-drop-app.vercel.app"),
  title: "DROPSYNC // OP/INTELLIGENCE",
  description: "Secure file transfer system. Drop anywhere, pickup anywhere. Auto-expire 2hrs.",
  icons: {
    icon: "/icon.svg?v=2",
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${raleway.variable} font-[family-name:var(--font-inter)] antialiased`} suppressHydrationWarning>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}