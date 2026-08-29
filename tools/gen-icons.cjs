#!/usr/bin/env node
// One-off generator for icons/icon{16,48,128}.png — no dependencies.
// A green rounded square with a white "skip-next" glyph (▶▶|), rendered
// 4x supersampled for smooth edges. Usage: node tools/gen-icons.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG write

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// ------------------------------------------------------------------ drawing

const BG = [0x16, 0xa3, 0x4a]; // green, matches the badge color
const FG = [0xff, 0xff, 0xff];

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// u, v in [0,1]. Returns [r,g,b,a] for that point.
function sample(u, v) {
  const radius = 0.22;
  const cx = Math.max(radius, Math.min(1 - radius, u));
  const cy = Math.max(radius, Math.min(1 - radius, v));
  const inSquare = (u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2;
  if (!inSquare) return [0, 0, 0, 0];

  const glyph =
    inTriangle(u, v, [0.20, 0.30], [0.20, 0.70], [0.47, 0.50]) ||
    inTriangle(u, v, [0.44, 0.30], [0.44, 0.70], [0.71, 0.50]) ||
    (u >= 0.72 && u <= 0.80 && v >= 0.30 && v <= 0.70);

  const c = glyph ? FG : BG;
  return [c[0], c[1], c[2], 255];
}

function render(size) {
  const ss = 4; // supersampling factor
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const [pr, pg, pb, pa] = sample(u, v);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  writePng(path.join(outDir, `icon${size}.png`), size, render(size));
  console.log(`icons/icon${size}.png`);
}
