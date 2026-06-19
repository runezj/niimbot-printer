/**
 * Build a 1-bit label bitmap (QR + optional caption) with no canvas/DOM.
 *
 * The QR comes straight from its module matrix (the `qrcode` package's core) and
 * the caption is drawn with a built-in 5×7 font. Deterministic and self-contained.
 */
import { FONT_HEIGHT, FONT_WIDTH, glyphFor } from './font5x7';

// `qrcode`'s core entry has no type declarations; it returns a module bit-matrix.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrCore = require('qrcode/lib/core/qrcode') as {
  create: (
    data: string,
    opts?: { errorCorrectionLevel?: string }
  ) => { modules: { size: number; data: Uint8Array | number[] } };
};

/** Niimbot B1: 203 dpi ≈ 8 dots/mm, max print width 384 dots (~48 mm). */
export const DOTS_PER_MM = 8;
export const MAX_PRINT_WIDTH_DOTS = 384;

export type MonoBitmap = {
  /** Scanlines (feed direction). */
  rows: number;
  /** Dots per scanline across the print head (≤ 384). */
  cols: number;
  bytesPerRow: number;
  /** rows * bytesPerRow, MSB-first, bit set = ink (black). */
  data: Uint8Array;
};

export function labelDotDimensions(
  widthMm: number,
  heightMm: number,
  opts?: { dotsPerMm?: number; maxWidthDots?: number }
): { cols: number; rows: number } {
  const dpm = opts?.dotsPerMm ?? DOTS_PER_MM;
  const maxW = opts?.maxWidthDots ?? MAX_PRINT_WIDTH_DOTS;
  const cols = Math.min(maxW, Math.max(8, Math.round(widthMm * dpm)));
  const rows = Math.max(1, Math.round(heightMm * dpm));
  return { cols, rows };
}

type Canvas = {
  cols: number;
  rows: number;
  bytesPerRow: number;
  data: Uint8Array;
  rotate180: boolean;
};

function plot(c: Canvas, x: number, y: number): void {
  let px = x;
  let py = y;
  if (c.rotate180) {
    px = c.cols - 1 - x;
    py = c.rows - 1 - y;
  }
  if (px < 0 || px >= c.cols || py < 0 || py >= c.rows) return;
  c.data[py * c.bytesPerRow + (px >> 3)] |= 0x80 >> (px & 7);
}

function fillRect(c: Canvas, x0: number, y0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plot(c, x0 + x, y0 + y);
}

/** Draw a string with the 5×7 font at integer scale; returns the drawn width. */
function drawText(c: Canvas, text: string, x0: number, y0: number, scale: number): number {
  let cx = x0;
  const advance = (FONT_WIDTH + 1) * scale;
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let row = 0; row < FONT_HEIGHT; row++) {
      const bits = glyph[row];
      for (let col = 0; col < FONT_WIDTH; col++) {
        if (bits & (0x10 >> col)) {
          fillRect(c, cx + col * scale, y0 + row * scale, scale, scale);
        }
      }
    }
    cx += advance;
  }
  return cx - x0;
}

function textPixelWidth(len: number, scale: number): number {
  return len > 0 ? len * (FONT_WIDTH + 1) * scale - scale : 0;
}

/** Largest integer scale whose rendered text fits within w×h, else 0. */
function fitTextScale(len: number, w: number, h: number): number {
  for (let s = 4; s >= 1; s--) {
    if (textPixelWidth(len, s) <= w && FONT_HEIGHT * s <= h) return s;
  }
  return 0;
}

export type QrLabelParams = {
  /** QR payload. */
  value: string;
  /** Optional caption drawn beside (landscape) or below (portrait) the QR. */
  text?: string;
  cols: number;
  rows: number;
  rotate180?: boolean;
};

export function buildQrLabelBitmap(params: QrLabelParams): MonoBitmap {
  const { value, cols, rows } = params;
  const bytesPerRow = Math.ceil(cols / 8);
  const canvas: Canvas = {
    cols,
    rows,
    bytesPerRow,
    data: new Uint8Array(bytesPerRow * rows),
    rotate180: params.rotate180 ?? false,
  };

  const matrix = qrCore.create(value || ' ', { errorCorrectionLevel: 'M' }).modules;
  const n = matrix.size;
  const at = (mx: number, my: number) => Boolean(matrix.data[my * n + mx]);

  const landscape = cols >= rows;
  const text = (params.text ?? '').trim();
  const margin = Math.max(2, Math.round(Math.min(cols, rows) * 0.05));
  const QUIET = 2; // QR quiet-zone modules

  // Reserve a text strip (right in landscape, bottom in portrait) when there's text.
  const textStrip = text ? Math.round(Math.min(cols, rows) * (landscape ? 0.42 : 0.28)) : 0;

  const qrAvail = landscape
    ? { w: cols - textStrip - margin, h: rows - margin * 2 }
    : { w: cols - margin * 2, h: rows - textStrip - margin };

  const square = Math.max(8, Math.min(qrAvail.w, qrAvail.h));
  const moduleSize = Math.max(1, Math.floor(square / (n + QUIET * 2)));
  const qrSize = moduleSize * n;

  const qrX = margin + Math.max(0, Math.floor((qrAvail.w - qrSize) / 2));
  const qrY = landscape
    ? Math.max(0, Math.floor((rows - qrSize) / 2))
    : margin + Math.max(0, Math.floor((qrAvail.h - qrSize) / 2));

  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (at(mx, my)) fillRect(canvas, qrX + mx * moduleSize, qrY + my * moduleSize, moduleSize, moduleSize);
    }
  }

  if (text) {
    const region = landscape
      ? { x: qrX + qrSize + margin, y: 0, w: cols - (qrX + qrSize + margin) - margin, h: rows }
      : { x: margin, y: qrY + qrSize + margin, w: cols - margin * 2, h: rows - (qrY + qrSize + margin) };

    let line = text;
    let scale = fitTextScale(line.length, region.w, region.h);
    if (scale === 0) {
      while (line.length > 1 && textPixelWidth(line.length, 1) > region.w) {
        line = line.slice(0, -1);
      }
      scale = 1;
    }
    const drawW = textPixelWidth(line.length, scale);
    const tx = region.x + Math.max(0, Math.floor((region.w - drawW) / 2));
    const ty = region.y + Math.max(0, Math.floor((region.h - FONT_HEIGHT * scale) / 2));
    drawText(canvas, line, tx, ty, scale);
  }

  return { rows, cols, bytesPerRow, data: canvas.data };
}
