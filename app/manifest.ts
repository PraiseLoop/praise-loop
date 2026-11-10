import type { MetadataRoute } from "next";
import {
  PWA_BACKGROUND_COLOR,
  PWA_DESCRIPTION,
  PWA_ICONS,
  PWA_NAME,
  PWA_START_URL,
  PWA_THEME_COLOR
} from "../lib/installable";

// Served by Next at /manifest.webmanifest. Every field here is public; the
// approval queue it opens still requires an owner session.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PWA_NAME,
    short_name: PWA_NAME,
    description: PWA_DESCRIPTION,
    id: "/",
    start_url: PWA_START_URL,
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: PWA_ICONS.map(icon => ({ ...icon }))
  };
}
