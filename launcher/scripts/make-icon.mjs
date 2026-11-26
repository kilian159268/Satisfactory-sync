/**
 * Erzeugt das App-Symbol aus dem V3in-Logo (Sechseck + zwei Striche, Entwurf
 * docs/design/launcher-entwurf.dc.html) auf dunklem Grund:
 *   build/icon.svg  – Quelle
 *   build/icon.png  – 512 × 512 (Linux/electron-builder)
 *   build/icon.ico  – 16…256 px (Windows, NSIS); unter 256 px als BMP, 256 px als PNG
 *
 * Aufruf: `node scripts/make-icon.mjs` (im Ordner launcher/). Ergebnisdateien werden committet.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

const BACKGROUND = '#1C1D20';
const ORANGE = '#F59A4A';
const ORANGE_LIGHT = '#FBC793';

/** Logo aus dem Entwurf (viewBox 0 0 800 800), etwas verkleinert, damit Rand bleibt. */
export function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 800 800">
  <rect width="800" height="800" rx="144" fill="${BACKGROUND}"/>
  <g transform="translate(400 400) scale(0.82) translate(-400 -400)">
    <polygon points="400,31 721,216 721,584 400,769 79,584 79,216" fill="none" stroke="${ORANGE}" stroke-width="44" stroke-linejoin="miter"/>
    <polygon points="178,238 258,238 400,478 400,612" fill="${ORANGE}"/>
    <polygon points="545,238 625,238 400,612 400,478" fill="${ORANGE_LIGHT}"/>
  </g>
</svg>
`;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Ab dieser Größe wird der Eintrag als PNG gespeichert (Windows Vista+), darunter als BMP. */
const PNG_FROM = 256;

async function renderPng(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toBuffer();
}

/** 32-Bit-DIB (BGRA, von unten nach oben) plus leere AND-Maske, wie im ICO-Format verlangt. */
async function renderBmp(svg, size) {
  const { data } = await sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      pixels[dst] = data[src + 2]; // B
      pixels[dst + 1] = data[src + 1]; // G
      pixels[dst + 2] = data[src]; // R
      pixels[dst + 3] = data[src + 3]; // A
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // 0 = sichtbar; Transparenz kommt aus dem Alphakanal
  return Buffer.concat([header, pixels, mask]);
}

/** Baut eine ICO-Datei aus fertigen Bilddaten (BMP-DIB oder PNG je Eintrag). */
export function packIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // Typ 1 = Icon
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // Palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // Planes
    dir.writeUInt16LE(32, o + 6); // Bit pro Pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

async function main() {
  await mkdir(BUILD_DIR, { recursive: true });
  const svg = iconSvg();
  await writeFile(join(BUILD_DIR, 'icon.svg'), svg);
  await writeFile(join(BUILD_DIR, 'icon.png'), await renderPng(svg, 512));
  const entries = [];
  for (const size of ICO_SIZES) {
    const data = size >= PNG_FROM ? await renderPng(svg, size) : await renderBmp(svg, size);
    entries.push({ size, data });
  }
  await writeFile(join(BUILD_DIR, 'icon.ico'), packIco(entries));
  console.log(
    `Symbol erzeugt in ${BUILD_DIR} (icon.svg, icon.png, icon.ico: ${ICO_SIZES.join(', ')} px)`,
  );
}

await main();
