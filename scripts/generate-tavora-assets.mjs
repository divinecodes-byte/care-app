// Generates assets/brand/tavora-icon.png and assets/brand/tavora-mark.png from inline SVG sources.
// Run with: node scripts/generate-tavora-assets.mjs
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'assets', 'brand');

const SIZE = 1024;

// Brand palette (matches constants/theme.ts `T`)
const COBALT = '#4361EE';
const WHITE = '#FFFFFF';

// Heart silhouette path, authored in a 0-120 x 0-93 local space, point-down.
const HEART_PATH =
    'M 50 88 C 10 60, -10 30, 20 10 C 40 -5, 50 5, 50 20 C 50 5, 60 -5, 80 10 C 110 30, 90 60, 50 88 Z';

// Scales + centers the heart path within a SIZE x SIZE canvas at the given fraction of width.
function heartTransform(targetWidth) {
    const scale = targetWidth / 120;
    const bboxCenterX = 50;
    const bboxCenterY = 41.5;
    const tx = SIZE / 2 - bboxCenterX * scale;
    const ty = SIZE / 2 - bboxCenterY * scale;
    return `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)})`;
}

// Checkmark polyline, positioned over the lower/center of the heart.
const CHECK_POINTS = '418,548 486,616 612,462';

function checkmark(color, strokeWidth) {
    return `<polyline points="${CHECK_POINTS}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
}

// App icon: full-bleed cobalt square (iOS applies its own corner mask), white heart, cobalt check.
const iconSvg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SIZE}" height="${SIZE}" fill="${COBALT}" />
  <path d="${HEART_PATH}" fill="${WHITE}" transform="${heartTransform(560)}" />
  ${checkmark(COBALT, 46)}
</svg>
`;

// Standalone mark: transparent background, cobalt heart, white check. Same symbol language, no square.
const markSvg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <path d="${HEART_PATH}" fill="${COBALT}" transform="${heartTransform(720)}" />
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
