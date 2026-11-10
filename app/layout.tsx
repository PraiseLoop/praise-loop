import AppShell from "./AppShell";
import ServiceWorkerRegistrar from "./ui/ServiceWorkerRegistrar";
import type { Metadata, Viewport } from "next";
import { installMetadata, installViewport } from "../lib/installable";
import "./globals.css";

export const metadata: Metadata = installMetadata;
export const viewport: Viewport = installViewport;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&display=swap" />
      </head>
      <body><ServiceWorkerRegistrar /><AppShell>{children}</AppShell></body>
    </html>
  );
}
