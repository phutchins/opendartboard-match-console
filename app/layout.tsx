import type { Metadata } from 'next';

import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://opendartboard-match-console.flipture.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'OpenDartboard Match Console',
  description: 'A local game console for OpenDartboard automatic scoring.',
  openGraph: {
    title: 'OpenDartboard Match Console',
    description: 'Local play. Live scoring.',
    images: [{
      url: '/opendartboard-match-console-share.png',
      width: 1536,
      height: 1024,
      alt: 'OpenDartboard Match Console live match screen',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OpenDartboard Match Console',
    description: 'Local play. Live scoring.',
    images: ['/opendartboard-match-console-share.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
