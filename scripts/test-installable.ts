import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import manifest from "../app/manifest";
import {
  APPLE_TOUCH_ICON,
  installMetadata,
  installViewport,
  PWA_BACKGROUND_COLOR,
  PWA_ICONS,
  PWA_NAME,
  PWA_START_URL,
  PWA_THEME_COLOR
} from "../lib/installable";
import { detectInstallPlatform, INSTALL_HINT_DISMISSED_KEY, shouldShowInstallHint } from "../lib/installHint";

async function main() {
  const file = manifest();

  // The manifest itself, served at /manifest.webmanifest by app/manifest.ts.
  assert.equal(file.name, PWA_NAME);
  assert.equal(file.short_name, PWA_NAME);
  assert.equal(file.start_url, PWA_START_URL);
  assert.equal(file.start_url, "/approval", "installing the app opens the approval queue");
  assert.equal(file.display, "standalone");
  assert.equal(file.theme_color, PWA_THEME_COLOR);
  assert.equal(file.background_color, PWA_BACKGROUND_COLOR);
  assert.equal(file.scope, "/");

  // Colours must stay the design tokens, not a second palette.
  const css = readFileSync(join("app", "globals.css"), "utf8");
  const token = (name: string) => {
    const match = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, `--${name} is defined in app/globals.css`);
    return match[1].toUpperCase();
  };
  assert.equal(PWA_THEME_COLOR.toUpperCase(), token("pl-green"));
  assert.equal(PWA_BACKGROUND_COLOR.toUpperCase(), token("pl-ground"));

  // Icons exist, are PNGs and are exactly the sizes the manifest promises.
  assert.deepEqual(PWA_ICONS.map(icon => icon.sizes), ["192x192", "512x512", "512x512"]);
  assert.ok(PWA_ICONS.some(icon => icon.purpose === "maskable" && icon.sizes === "512x512"), "a maskable 512 is offered");
  for (const icon of file.icons ?? []) {
    assert.ok(icon.src, "every icon has a src");
    const path = join("public", icon.src);
    assert.ok(existsSync(path), `${icon.src} is committed under public/`);
    const meta = await sharp(path).metadata();
    assert.equal(meta.format, "png");
    assert.equal(`${meta.width}x${meta.height}`, icon.sizes, `${icon.src} matches its declared size`);
  }

  // iOS needs its own opaque touch icon and meta tags; iOS ignores the manifest icons.
  assert.ok(file.icons?.some(icon => icon.purpose === "maskable"), "the maskable icon is declared");
  const metadataIcons = installMetadata.icons as { apple?: Array<{ url: string }> };
  assert.ok(metadataIcons.apple?.some(icon => icon.url === APPLE_TOUCH_ICON), "the apple-touch-icon is linked");
  const applePath = join("public", APPLE_TOUCH_ICON);
  assert.ok(existsSync(applePath), "apple-touch-icon.png is committed");
  const appleMeta = await sharp(applePath).metadata();
  assert.equal(`${appleMeta.width}x${appleMeta.height}`, "180x180");
  const appleWebApp = installMetadata.appleWebApp as { capable?: boolean; title?: string };
  assert.equal(appleWebApp.capable, true);
  assert.equal(appleWebApp.title, PWA_NAME);
  assert.equal((installMetadata.other as Record<string, string>)["apple-mobile-web-app-capable"], "yes", "iOS still needs its own standalone tag");
  assert.equal(installMetadata.manifest, "/manifest.webmanifest");
  assert.equal(installViewport.themeColor, PWA_THEME_COLOR);

  // The service worker exists for installability but must never cache owner data or media.
  const worker = readFileSync(join("public", "sw.js"), "utf8");
  assert.match(worker, /addEventListener\("fetch"/, "the installability check sees a fetch handler");
  assert.doesNotMatch(worker, /\bcaches\b|cache\.(add|addAll|put|match|open)/, "no Cache API use, so nothing private is cached");
  assert.doesNotMatch(worker, /addEventListener\("push"\)|showNotification/, "no web push in this change");

  // Pure rule: the hint is only for a signed-in phone that can actually install.
  const base = { signedIn: true, standalone: false, dismissed: false, platform: "ios-safari" as const, promptAvailable: false };
  assert.equal(shouldShowInstallHint(base), true, "iPhone Safari gets instructions");
  assert.equal(shouldShowInstallHint({ ...base, promptAvailable: true }), true);
  assert.equal(shouldShowInstallHint({ ...base, signedIn: false }), false, "signed-out visitors are not asked");
  assert.equal(shouldShowInstallHint({ ...base, standalone: true }), false, "already installed");
  assert.equal(shouldShowInstallHint({ ...base, dismissed: true }), false, "dismissal is respected");
  assert.equal(shouldShowInstallHint({ ...base, platform: "other" }), false, "desktop and in-app browsers get no hint");
  assert.equal(shouldShowInstallHint({ ...base, platform: "android", promptAvailable: false }), false, "Android waits for the browser prompt");
  assert.equal(shouldShowInstallHint({ ...base, platform: "android", promptAvailable: true }), true);
  assert.equal(INSTALL_HINT_DISMISSED_KEY, "praise-install-hint-dismissed");

  // Platform detection: Safari on iOS only; not Chrome/Firefox/in-app browsers on iOS.
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"), "ios-safari");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"), "ios-safari");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1"), "other");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]"), "other");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"), "android");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"), "other");

  console.log("Installable web app manifest, icons, service worker and hint rule passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
