// Generates assets/brand/tavora-icon.png and assets/brand/tavora-mark.png from inline SVG sources.
// Run with: node scripts/generate-tavora-assets.mjs
//
// Build Batch 1 (Week 4 product-reset task #1, see docs/product-reset-audit.md
// §7 item B6): the mark was previously a heart silhouette with a checkmark --
// the single most visible caregiving-coded signal in the whole app (it's the
// literal App Store/home-screen icon). Replaced with a neutral circular
// badge + checkmark: no relationship connotation, same cobalt/white brand
// palette, same checkmark language (a completed accountability item), same
// two output files/paths, same iOS/Android/splash wiring in app.json --
// only the silhouette itself changed. This does NOT touch bundleIdentifier,
// EAS project id, or any other app/store identity (see app.json -- none of
// those fields reference this script's output beyond the icon image path).
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'assets', 'brand');

const SIZE = 1024;
const CENTER = SIZE / 2;

// Brand palette (matches constants/theme.ts `T`)
const COBALT = '#4361EE';
const WHITE = '#FFFFFF';

// Checkmark polyline -- unchanged from the previous mark (already neutral),
// re-centered slightly for a circular badge instead of a point-down heart.
const CHECK_POINTS = '400,530 480,610 640,420';

function checkmark(color, strokeWidth) {
    return `<polyline points="${CHECK_POINTS}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function badgeCircle(fill, radius) {
    return `<circle cx="${CENTER}" cy="${CENTER}" r="${radius}" fill="${fill}" />`;
}

// App icon: full-bleed cobalt square (iOS applies its own corner mask), white circle badge, cobalt check.
const iconSvg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SIZE}" height="${SIZE}" fill="${COBALT}" />
  ${badgeCircle(WHITE, 300)}
  ${checkmark(COBALT, 46)}
</svg>
`;

// Standalone mark: transparent background, cobalt circle badge, white check. Same symbol language, no square.
const markSvg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  ${badgeCircle(COBALT, 380)}
  ${checkmark(WHITE, 58)}
</svg>
`;

await mkdir(outDir, { recursive: true });

await sharp(Buffer.from(iconSvg))
    .resize(SIZE, SIZE)
    .flatten({ background: COBALT })
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, 'tavora-icon.png'));

await sharp(Buffer.from(markSvg))
    .resize(SIZE, SIZE)
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, 'tavora-mark.png'));

console.log('Generated tavora-icon.png and tavora-mark.png in assets/brand/');
