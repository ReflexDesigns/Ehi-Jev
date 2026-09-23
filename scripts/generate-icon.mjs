#!/usr/bin/env node
/**
 * Genera le icone raster di HeyJev (PNG + ICO) per Tauri.
 *
 * Disegna proceduralmente una "J" neon (ciano -> viola) su sfondo scuro
 * arrotondato, coerente con il brand di ehi_jev_logo.svg, usando solo
 * Node.js + zlib (nessuna dipendenza esterna).
 *
 * Output in src-tauri/icons/:
 *   32x32.png, 128x128.png, 128x128@2x.png, icon.png (512), icon.ico
 *
 * Uso: npm run icons   (o: node scripts/generate-icon.mjs)
 *
 * Nota: per icone ancora più fedeli al logo vettoriale, dopo aver installato
 * le dipendenze puoi anche eseguire: npx @tauri-apps/cli icon public/app-icon.svg
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------- Utilità PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Icona ICO (PNG embedded, valida da Vista in poi) ---------- */

function encodeIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // riservato
  header.writeUInt16LE(1, 2); // tipo: icona
  header.writeUInt16LE(1, 4); // numero immagini
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 = 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0; // riservato
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8); // dimensione
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, pngBuf]);
}

/* ---------- Disegno (coordinate normalizzate 0..1) ---------- */

const CYAN = [0, 242, 254];
const GREEN = [56, 239, 125];
const PURPLE = [127, 0, 255];
const MAGENTA = [225, 0, 255];
const BG_CENTER = [31, 40, 56];
const BG_EDGE = [10, 13, 20];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerp3(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

/** Gradiente a 4 stop del brand (ciano -> verde -> viola -> magenta). */
function brandGradient(t) {
  if (t < 0.4) return lerp3(CYAN, GREEN, t / 0.4);
  if (t < 0.7) return lerp3(GREEN, PURPLE, (t - 0.4) / 0.3);
  return lerp3(PURPLE, MAGENTA, Math.min(1, (t - 0.7) / 0.3));
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby || 1)));
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}

/** Distanza (normalizzata) dal centro della lettera "J" neon. */
function distToJ(u, v) {
  const AX = 0.648, AY = 0.234; // cima dell'asta verticale
  const BX = 0.648, BY = 0.672; // base dell'asta
  const CX = 0.5, CY = 0.672, R = 0.148; // centro/raggio della curva
  const dSeg = distToSegment(u, v, AX, AY, BX, BY);
  const dx = u - CX;
  const dy = v - CY;
  const dArc = Math.abs(Math.hypot(dx, dy) - R);
  const inLowerHalf = dy >= 0;
  return Math.min(dSeg, inLowerHalf ? dArc : 1e9);
}

function buildIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cornerRadius = 0.215;
  const halfW = 0.0664; // mezza larghezza della "J"
  const aa = 1.5 / size; // anti-aliasing (1.5px)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // --- Sfondo arrotondato con glow radiale ---
      const cx = 0.5, cy = 0.5;
      const dEdge = Math.max(Math.abs(u - cx), Math.abs(v - cy));
      const corner = Math.hypot(
        Math.max(0, Math.abs(u - cx) - (0.5 - cornerRadius)),
        Math.max(0, Math.abs(v - cy) - (0.5 - cornerRadius)),
      );
      const bgAlpha = 1 - Math.max(0, Math.min(1, (corner - cornerRadius + aa) / aa));
      const distC = Math.hypot(u - cx, v - cy);
      const tBg = Math.min(1, distC / 0.75);
      let rgb = lerp3(BG_CENTER, BG_EDGE, tBg);
      // leggero alone ciano sul bordo
      const edgeGlow = Math.max(0, (corner + cornerRadius - (0.5 + cornerRadius - 0.05)) / 0.05);
      rgb = lerp3(rgb, CYAN, Math.min(1, edgeGlow) * 0.18);

      // --- "J" neon con glow ---
      const d = distToJ(u, v);
      const glowA = Math.max(0, Math.min(1, (halfW + 0.055 - d) / 0.055)) * 0.35;
      const coreA = Math.max(0, Math.min(1, (halfW - d) / aa));
      const gradT = Math.max(0, Math.min(1, (u - 0.35) / 0.3));
      const jColor = brandGradient(gradT);

      // composizione: glow (ciano) + corpo (gradiente)
      rgb = [
        rgb[0] + (CYAN[0] - rgb[0]) * glowA,
        rgb[1] + (CYAN[1] - rgb[1]) * glowA,
        rgb[2] + (CYAN[2] - rgb[2]) * glowA,
      ];
      rgb = [
        rgb[0] + (jColor[0] - rgb[0]) * coreA,
        rgb[1] + (jColor[1] - rgb[1]) * coreA,
        rgb[2] + (jColor[2] - rgb[2]) * coreA,
      ];

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(Math.min(255, Math.max(0, rgb[0])));
      rgba[i + 1] = Math.round(Math.min(255, Math.max(0, rgb[1])));
      rgba[i + 2] = Math.round(Math.min(255, Math.max(0, rgb[2])));
      rgba[i + 3] = Math.round(Math.min(255, Math.max(0, bgAlpha * 255)));
    }
  }
  return rgba;
}

/* ---------- Generazione ---------- */

const targets = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
];

for (const { name, size } of targets) {
  const png = encodePng(size, size, buildIcon(size));
  writeFileSync(join(outDir, name), png);
  console.log(`OK  src-tauri/icons/${name} (${png.length} bytes)`);
}

const ico = encodeIco(encodePng(256, 256, buildIcon(256)), 256);
writeFileSync(join(outDir, 'icon.ico'), ico);
console.log(`OK  src-tauri/icons/icon.ico (${ico.length} bytes)`);
