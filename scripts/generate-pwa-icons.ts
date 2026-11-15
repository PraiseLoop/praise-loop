import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

// Regenerate the installable web app icons from the shared app icon (#273).
// The source is the PraiseLoop tile in mobile/assets/icon.png; its artwork lives
// in assets/brand/praiseloop-app-icon.svg, so change the logo there, re-export the
// 1024px mobile icon, then run this:
//   npx ts-node --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' scripts/generate-pwa-icons.ts
const source = join("mobile", "assets", "icon.png");
const outputDir = join("public", "icons");

async function resize(size: number, path: string) {
  await sharp(source)
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(path);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await resize(192, join(outputDir, "icon-192.png"));
  await resize(512, join(outputDir, "icon-512.png"));
  // The source is a full-bleed square with its mark well inside the central 80%,
  // so it already satisfies the maskable safe zone.
  await resize(512, join(outputDir, "icon-maskable-512.png"));
  await resize(180, join("public", "apple-touch-icon.png"));
  await resize(32, join(outputDir, "favicon-32.png"));
  console.log("Wrote public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, favicon-32.png and public/apple-touch-icon.png");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
