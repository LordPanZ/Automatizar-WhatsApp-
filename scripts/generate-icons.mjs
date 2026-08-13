/**
 * Genera los iconos PNG del panel sin dependencias externas.
 *   node scripts/generate-icons.mjs
 *
 * Dibuja un bocadillo de chat blanco sobre fondo verde, con tres líneas
 * dentro que sugieren un mensaje redactado. Se renderiza a 4x y se reduce
 * después, que es la forma barata de tener bordes suaves sin un rasterizador.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SS = 4; // factor de supermuestreo

const GREEN = [31, 138, 76, 255];
const WHITE = [255, 255, 255, 255];

/* --- primitivas de dibujo ------------------------------------------------ */

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blend(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const alpha = a / 255;
  const inv = 1 - alpha;
  canvas.data[i] = r * alpha + canvas.data[i] * inv;
  canvas.data[i + 1] = g * alpha + canvas.data[i + 1] * inv;
  canvas.data[i + 2] = b * alpha + canvas.data[i + 2] * inv;
  canvas.data[i + 3] = a + canvas.data[i + 3] * inv;
}

function fillRect(canvas, x0, y0, w, h, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      blend(canvas, x, y, color);
    }
  }
}

function fillRoundedRect(canvas, x0, y0, w, h, radius, color) {
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      // Distancia a la esquina más cercana; fuera del radio, no se pinta.
      const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r - 1));
      const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r - 1));
      if (dx * dx + dy * dy <= r * r) blend(canvas, x, y, color);
    }
  }
}

/** Triángulo (la cola del bocadillo) por coordenadas baricéntricas. */
function fillTriangle(canvas, [ax, ay], [bx, by], [cx, cy], color) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (area === 0) return;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w0 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
      const w1 = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area;
      if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) blend(canvas, x, y, color);
    }
  }
}

/** Media de bloques SSxSS: es lo que suaviza los bordes. */
function downsample(canvas, factor) {
  const size = canvas.size / factor;
  const out = createCanvas(size);
  const samples = factor * factor;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const i = ((y * factor + sy) * canvas.size + (x * factor + sx)) * 4;
          r += canvas.data[i];
          g += canvas.data[i + 1];
          b += canvas.data[i + 2];
          a += canvas.data[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out.data[o] = r / samples;
      out.data[o + 1] = g / samples;
      out.data[o + 2] = b / samples;
      out.data[o + 3] = a / samples;
    }
  }
  return out;
}

/* --- codificación PNG ---------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  // Cada scanline lleva delante un byte de filtro (0 = ninguno).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size * 4; x += 1) {
      raw[offset] = data[y * size * 4 + x];
      offset += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- el icono ------------------------------------------------------------ */

function drawIcon(size, { fullBleed }) {
  const canvas = createCanvas(size * SS);
  const s = size * SS;

  // Fondo. A sangre para iconos "maskable"; con esquinas redondeadas si no.
  if (fullBleed) fillRect(canvas, 0, 0, s, s, GREEN);
  else fillRoundedRect(canvas, 0, 0, s, s, s * 0.22, GREEN);

  // Zona segura: en maskable el sistema puede recortar hasta un 20% por lado.
  const inset = fullBleed ? s * 0.26 : s * 0.2;
  const bw = s - inset * 2;
  const bh = bw * 0.74;
  const bx = inset;
  const by = inset + bw * 0.04;

  fillRoundedRect(canvas, bx, by, bw, bh, bw * 0.2, WHITE);
  fillTriangle(
    canvas,
    [bx + bw * 0.24, by + bh - 1],
    [bx + bw * 0.46, by + bh - 1],
    [bx + bw * 0.24, by + bh + bh * 0.3],
    WHITE,
  );

  // Tres líneas de texto, la última más corta.
  const lineH = bh * 0.1;
  const gap = bh * 0.16;
  const lx = bx + bw * 0.17;
  let ly = by + bh * 0.24;
  for (const widthFactor of [0.66, 0.66, 0.4]) {
    fillRoundedRect(canvas, lx, ly, bw * widthFactor, lineH, lineH / 2, GREEN);
    ly += gap;
  }

  return downsample(canvas, SS);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, fullBleed: true },
  { file: 'icon-512.png', size: 512, fullBleed: true },
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true },
  { file: 'favicon-64.png', size: 64, fullBleed: false },
];

for (const target of targets) {
  const png = encodePng(drawIcon(target.size, { fullBleed: target.fullBleed }));
  fs.writeFileSync(path.join(OUT_DIR, target.file), png);
  console.log(`${target.file}  ${target.size}x${target.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
