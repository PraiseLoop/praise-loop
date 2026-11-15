# PraiseLoop logo

The mark is a clockwise loop arrow wrapping a five-point star: reviews come in,
branded posts go out, the loop repeats. Green is the product's structural colour,
marigold is the praise itself.

## Files

| File | Use |
|---|---|
| `praiseloop-mark.svg` | Primary mark, transparent background. Use this by default. |
| `praiseloop-mark-1024.png` | Raster of the primary mark. |
| `praiseloop-mark-reverse.svg` / `-reverse-1024.png` | Cream mark for green or dark surfaces. The app shell draws this version inline (`app/ui/BrandMark.tsx`). |
| `praiseloop-lockup.svg` / `.png` | Horizontal mark + wordmark, for headers and documents. |
| `praiseloop-lockup-reverse.svg` | Lockup for green surfaces. |
| `praiseloop-app-icon.svg` | Full-bleed 512 tile. The platform or browser applies its own rounding and mask. |
| `praiseloop-app-icon-rounded.svg` | The same tile with corners drawn, for sheets, docs and previews. |
| `icons/` | Rendered PNGs: 192, 512, maskable 512, Apple touch 180, favicon 32. Committed copies live in `public/`. |
| `praiseloop-brand-sheet.png` | One-page overview of the suite. |

## Colour

| Swatch | Hex | Role |
|---|---|---|
| Deep green | `#0E5A48` | Mark, icon tile |
| Marigold | `#F4B731` | Star |
| Cream | `#F7F4EA` | Mark on green |
| Ink | `#17201C` | Wordmark on light |

## Rules

- Keep clear space around the mark of at least 25% of its width on every side.
- Minimum size: 20px for the mark, 96px wide for the lockup.
- Do not recolour, rotate, add gradients or shadows, or place the green mark on mid-tone colours — use the reverse version instead.
- The wordmark is set in Bricolage Grotesque 700, tracking -1.1 at 47 units. The SVG references the font by name, so the app's webfont or `assets/fonts/BricolageGrotesque.ttf` must be available; the PNG has the type baked in.

## One source of truth

The artwork here feeds everything else:

1. `mobile/assets/icon.png` is the 1024px export of `praiseloop-app-icon.svg` and is the icon Expo builds the phone app from.
2. `scripts/generate-pwa-icons.ts` resizes that export into `public/icons/` (192, 512, maskable 512, favicon 32) and `public/apple-touch-icon.png`.
3. `app/ui/BrandMark.tsx` inlines `praiseloop-mark-reverse.svg` for the in-app brand link, so the shell needs no extra request.

Change the logo in this folder first, then re-export the mobile icon and run the generator:

```bash
npx ts-node --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' scripts/generate-pwa-icons.ts
```

`scripts/test-installable.ts` checks the generated sizes and that the manifest colours still match the design tokens.
