import { join, resolve } from "node:path";

// Shared durable media storage. In Compose, the `generated_media` volume is
// mounted at /app/private-media on both web and worker (see
// docker-compose.yml), so the default below resolves to the mount point.
// Override with MEDIA_ROOT for host runs or custom layouts.
export function mediaRoot(): string {
  const configured = process.env.MEDIA_ROOT?.trim();
  return resolve(configured ? configured : join(process.cwd(), "private-media"));
}

export function draftImageFilename(draftPostId: number, digest?: string): string {
  return `draft-${draftPostId}${digest ? `-${digest}` : ""}.png`;
}

// The deterministic JPEG variant Instagram needs. The digest is over the JPEG
// bytes, not the PNG's, so the filename always names the exact stored file.
export function draftJpegFilename(draftPostId: number, digest?: string): string {
  return `draft-${draftPostId}${digest ? `-${digest}` : ""}.jpg`;
}

// URL the web runtime serves the artifact from. Stored in draft_posts.image_path
// so browsers fetch images through the Next server (never a bare filesystem path).
export function draftImageUrl(draftPostId: number, digest?: string): string {
  return `/api/media/${draftImageFilename(draftPostId, digest)}`;
}

export function draftJpegUrl(draftPostId: number, digest?: string): string {
  return `/api/media/${draftJpegFilename(draftPostId, digest)}`;
}
