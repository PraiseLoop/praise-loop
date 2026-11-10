import type { Metadata, Viewport } from "next";

// Installable-web-app identity (#273). Keep the colours in step with
// `--pl-green` and `--pl-ground` in app/globals.css; scripts/test-installable.ts
// checks that they still match.
export const PWA_NAME = "PraiseLoop";
export const PWA_DESCRIPTION = "Turn your best customer reviews into ready-to-post social content";
export const PWA_START_URL = "/approval";
export const PWA_THEME_COLOR = "#0E5A48";
export const PWA_BACKGROUND_COLOR = "#F5F6F1";

export type PwaIcon = {
  src: string;
  sizes: string;
  type: "image/png";
  purpose: "any" | "maskable";
};

// Generated from the existing app logo with scripts/generate-pwa-icons.ts.
// The maskable file keeps the mark inside the safe zone, so nothing important
// is cropped by an Android adaptive icon mask.
export const PWA_ICONS: readonly PwaIcon[] = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
];

export const APPLE_TOUCH_ICON = "/apple-touch-icon.png";

export const installMetadata: Metadata = {
  title: PWA_NAME,
  description: PWA_DESCRIPTION,
  applicationName: PWA_NAME,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: PWA_ICONS.filter(icon => icon.purpose === "any").map(icon => ({
      url: icon.src,
      sizes: icon.sizes,
      type: icon.type
    })),
    apple: [{ url: APPLE_TOUCH_ICON, sizes: "180x180", type: "image/png" }]
  },
  // iOS ignores the web app manifest for the home-screen title and chrome.
  appleWebApp: {
    capable: true,
    title: PWA_NAME,
    statusBarStyle: "default"
  },
  // Next emits the Chrome spelling (`mobile-web-app-capable`). iOS still reads
  // the apple-prefixed tag for a standalone home-screen launch.
  other: {
    "apple-mobile-web-app-capable": "yes"
  }
};

export const installViewport: Viewport = {
  themeColor: PWA_THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};
