// Gera icons/icon{16,32,48,128}.png sem dependências (rasterização com supersampling).
// Uso: node scripts/build-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));
const SIZES = [16, 32, 48, 128];
const SS = 8; // amostras por eixo

const A = [0x53, 0x6d, 0xfe]; // #536dfe
const B = [0x8a, 0x5c, 0xf6]; // #8a5cf6

// Geometria no espaço 128×128
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const SPEAKER = [
  [30, 51],
  [46, 51],
  [65, 34],
  [65, 94],
  [46, 77],
  [30, 77],
];
const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const inPolygon = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inSpeaker = (x, y) => {
  if (inPolygon(x, y, SPEAKER)) return true;
  for (let i = 0; i < SPEAKER.length; i++) {
    if (segDist(x, y, SPEAKER[i], SPEAKER[(i + 1) % SPEAKER.length]) <= 3) return true; // cantos arredondados
  }
  return false;
};

const inArc = (x, y, cx, cy, r, halfAngle, width) => {
  const dx = x - cx;
  const dy = y - cy;
  const ang = Math.atan2(dy, dx);
  if (Math.abs(ang) <= halfAngle && Math.abs(Math.hypot(dx, dy) - r) <= width / 2) return true;
  for (const s of [-1, 1]) {
    const ex = cx + r * Math.cos(s * halfAngle);
    const ey = cy + r * Math.sin(s * halfAngle);
    if (Math.hypot(x - ex, y - ey) <= width / 2) return true; // ponta arredondada
  }
  return false;
};

// Retorna [r,g,b,a] (0..1) de uma amostra
function sample(x, y) {
  if (!inRoundRect(x, y, 4, 4, 124, 124, 30)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (x + y - 8) / 232));
  const bg = A.map((c, i) => (c + (B[i] - c) * t) / 255);
  let white = 0;
  if (inSpeaker(x, y) || inArc(x, y, 68, 64, 18, 0.75, 9)) white = 1;
  else if (inArc(x, y, 68, 64, 34, 0.8, 9)) white = 0.8;
  return [bg[0] + (1 - bg[0]) * white, bg[1] + (1 - bg[1]) * white, bg[2] + (1 - bg[2]) * white, 1];
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample((pxi + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * size + pxi) * 4;
      if (a > 0) {
        px[i] = Math.round((r / a) * 255);
        px[i + 1] = Math.round((g / a) * 255);
        px[i + 2] = Math.round((b / a) * 255);
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  writeFileSync(`${OUT}icon${size}.png`, png(size, render(size)));
  console.log(`icons/icon${size}.png`);
}
