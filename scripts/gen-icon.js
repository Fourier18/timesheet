'use strict';
// Generates build/icon.png (256x256 RGBA) and build/icon.ico (PNG-embedded)
// using only Node built-ins (zlib). Draws a simple clock at 10:10.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // supersampling factor
const cx = 128, cy = 128;

// ---- geometry helpers ----
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// signed distance to a rounded rect centered on (cx,cy): <0 inside, =edge dist
function roundRectSDF(px, py, half, r) {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
function polar(deg, r) {
  const rad = (-90 + deg) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

// hands: classic 10:10
const [minTipX, minTipY] = polar(60, 70);    // minute at 2 o'clock
const [hrTipX, hrTipY] = polar(305, 50);     // hour just past 10
const ticks = [];
for (let k = 0; k < 12; k++) {
  const len = k % 3 === 0 ? 14 : 9;          // longer ticks at 12/3/6/9
  ticks.push([...polar(k * 30, 78 - len), ...polar(k * 30, 78)]);
}
// corner rivets on the steel plate
const rivets = [[cx - 92, cy - 92], [cx + 92, cy - 92], [cx - 92, cy + 92], [cx + 92, cy + 92]];

// palette
const PHOS = [70, 240, 138];        // phosphor green
const PHOS_HI = [142, 255, 185];    // bright phosphor

function colorAt(x, y) {
  const d = Math.hypot(x - cx, y - cy);

  // ---- recessed CRT screen (everything within the bezel) ----
  if (d <= 96) {
    if (d <= 7) return [...PHOS_HI, 255];                                  // center hub
    if (distSeg(x, y, cx, cy, minTipX, minTipY) <= 5)   return [...PHOS_HI, 255]; // minute hand
    if (distSeg(x, y, cx, cy, hrTipX, hrTipY) <= 5.5)   return [...PHOS_HI, 255]; // hour hand
    for (const t of ticks) if (distSeg(x, y, t[0], t[1], t[2], t[3]) <= 3) return [...PHOS, 255];
    if (d > 88 && d <= 94) return [...PHOS, 255];                          // glowing bezel ring
    if (d > 94) return [9, 12, 13, 255];                                   // dark recess gap
    // screen face: near-black with a soft green phosphor glow toward center
    const glow = Math.max(0, 1 - d / 88);
    let r = 6 + glow * 7, g = 16 + glow * 30, b = 12 + glow * 16;
    if (Math.floor(y) % 4 === 0) { r *= 0.45; g *= 0.45; b *= 0.45; }      // scanlines
    return [clamp8(r), clamp8(g), clamp8(b), 255];
  }

  // ---- industrial steel plate ----
  const s = roundRectSDF(x, y, 124, 46);
  if (s <= 0) {
    // rivets (shiny machined heads)
    for (const [rxc, ryc] of rivets) {
      const rd = Math.hypot(x - rxc, y - ryc);
      if (rd <= 7.5) {
        const t = Math.max(0, 1 - rd / 7.5);
        const v = 58 + t * 46;
        return [clamp8(v * 0.92), clamp8(v), clamp8(v * 1.02), 255];
      }
    }
    // brushed gunmetal vertical gradient
    const f = (y - (cy - 124)) / 248;
    let r = 48 + (20 - 48) * f, g = 56 + (24 - 56) * f, b = 60 + (26 - 60) * f;
    // beveled border: highlight the top edge, shadow the bottom edge
    const edge = -s;
    if (edge < 7) {
      const k = (7 - edge) / 7;
      if (y < cy) { r += 72 * k; g += 80 * k; b += 84 * k; }
      else        { r -= 22 * k; g -= 22 * k; b -= 22 * k; }
    }
    return [clamp8(r), clamp8(g), clamp8(b), 255];
  }
  return [0, 0, 0, 0];
}

// ---- render with supersampling ----
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let oy = 0; oy < SIZE; oy++) {
  for (let ox = 0; ox < SIZE; ox++) {
    let aR = 0, aG = 0, aB = 0, aA = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [r, g, b, a] = colorAt(ox + (sx + 0.5) / SS, oy + (sy + 0.5) / SS);
        aR += r * a; aG += g * a; aB += b * a; aA += a;
      }
    }
    const i = (oy * SIZE + ox) * 4;
    const alpha = aA / (SS * SS);
    if (aA > 0) {
      rgba[i] = Math.round(aR / aA);
      rgba[i + 1] = Math.round(aG / aA);
      rgba[i + 2] = Math.round(aB / aA);
    }
    rgba[i + 3] = Math.round(alpha);
  }
}

// ---- PNG encode ----
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function pngEncode(w, h, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function icoEncode(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = pngEncode(SIZE, SIZE, rgba);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoEncode(png, SIZE));
console.log(`icon.png + icon.ico written (${SIZE}px, ${png.length} bytes PNG)`);
