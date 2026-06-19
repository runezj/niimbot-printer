/**
 * High-level Niimbot print flow, transport-agnostic.
 *
 * Tested against the Niimbot B1 (which has its own command formats in
 * niimbluelib's B1PrintTask). The sequence:
 *
 *   setDensity → setLabelType → printStart(7b) → pageStart →
 *   setPageSize(6b: rows, cols, copies) → [bitmap rows] → pageEnd →
 *   wait-for-finish (status poll) → printEnd
 *
 * Control commands wait for an ack (best-effort — we continue on timeout).
 */
import { RequestCode, responseCodeFor, u16be } from './commands';
import { NiimbotPacket, NiimbotPacketParser } from './packet';
import type { NiimbotTransport } from './transport';
import type { MonoBitmap } from './label/labelBitmap';

const ERROR_PACKET_TYPE = 219; // 0xDB — printer-reported error

type Waiter = { code: number; resolve: (p: NiimbotPacket | null) => void; timer: ReturnType<typeof setTimeout> };

const hx = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');

export type PrintOptions = {
  /** 1–5 (3 is a good default). */
  density: number;
  /** Niimbot label type: 1 = with gaps (die-cut), the common roll. */
  labelType: number;
  /** Copies to print (default 1). */
  quantity?: number;
  /** Print-head width in dots, for the per-row segment counts. B1 = 384. */
  printheadPixels?: number;
};

function popcount(b: number): number {
  let v = b;
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
}

/**
 * Per-row header counts the printer actually uses: black pixels in each third
 * of the print head (niimbluelib `countPixelsForBitmapPacket`, "split" mode).
 * Sending zeros (as niimprint does) makes the B1 treat every row as empty.
 */
function rowSegmentCounts(line: Uint8Array, printheadPixels: number): [number, number, number] {
  const chunk = Math.floor(printheadPixels / 8 / 3);
  const parts: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < 3; p++) {
    let c = 0;
    for (let b = p * chunk; b < (p + 1) * chunk && b < line.length; b++) c += popcount(line[b]);
    parts[p] = c & 0xff;
  }
  return parts;
}

export class NiimbotPrinter {
  private parser = new NiimbotPacketParser();
  private waiters: Waiter[] = [];
  private unsubscribe: () => void;
  /** Every packet the printer sent during the current job (for diagnostics). */
  private received: NiimbotPacket[] = [];

  constructor(private readonly transport: NiimbotTransport) {
    this.unsubscribe = transport.onData((bytes) => {
      for (const pkt of this.parser.push(bytes)) {
        this.received.push(pkt);
        this.dispatch(pkt);
      }
    });
  }

  private dispatch(pkt: NiimbotPacket): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (pkt.type === w.code || pkt.type === ERROR_PACKET_TYPE) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(pkt.type === ERROR_PACKET_TYPE ? null : pkt);
      }
    }
  }

  private async transceive(request: number, data: Uint8Array, timeoutMs = 600): Promise<NiimbotPacket | null> {
    const code = responseCodeFor(request);
    const wait = new Promise<NiimbotPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ code, resolve, timer });
    });
    await this.transport.send(new NiimbotPacket(request, data).toBytes());
    return wait;
  }

  /** Runs the print sequence and returns a step-by-step diagnostic log. */
  async printBitmap(bmp: MonoBitmap, opts: PrintOptions): Promise<string> {
    const log: string[] = [];
    this.received = [];
    const printhead = opts.printheadPixels ?? 384;

    const step = async (name: string, req: number, data: Uint8Array, timeout = 600) => {
      const resp = await this.transceive(req, data, timeout);
      log.push(`${name} -> ${resp ? `ack 0x${resp.type.toString(16)} [${hx(resp.data)}]` : 'no ack'}`);
      return resp;
    };

    log.push(
      `bitmap ${bmp.cols}x${bmp.rows} (${bmp.bytesPerRow} B/row), density=${opts.density}, type=${opts.labelType}`
    );

    const quantity = opts.quantity ?? 1;

    await step('SET_DENSITY', RequestCode.SET_LABEL_DENSITY, Uint8Array.of(opts.density));
    await step('SET_LABEL_TYPE', RequestCode.SET_LABEL_TYPE, Uint8Array.of(opts.labelType));
    // B1 uses the 7-byte PrintStart (totalPages u16, 4×0x00, pageColor) — not the
    // old 1-byte [01]. (niimbluelib B1PrintTask.printStart7b)
    await step(
      'PRINT_START',
      RequestCode.START_PRINT,
      Uint8Array.of((quantity >> 8) & 0xff, quantity & 0xff, 0, 0, 0, 0, 0)
    );
    await step('PAGE_START', RequestCode.START_PAGE_PRINT, Uint8Array.of(0x01));
    // B1 uses the 6-byte SetPageSize (rows, cols, copies) — not the 4-byte
    // SetDimension + separate SetQuantity. (niimbluelib setPageSize6b)
    await step('SET_PAGE_SIZE', RequestCode.SET_DIMENSION, u16be(bmp.rows, bmp.cols, quantity));

    // Concatenate all row packets and send as one stream (the transport chunks/paces).
    const frames: number[] = [];
    for (let y = 0; y < bmp.rows; y++) {
      const line = bmp.data.subarray(y * bmp.bytesPerRow, (y + 1) * bmp.bytesPerRow);
      const counts = rowSegmentCounts(line, printhead);
      const packet = new Uint8Array(6 + line.length);
      packet[0] = (y >> 8) & 0xff; // line number (u16be)
      packet[1] = y & 0xff;
      packet[2] = counts[0]; // black-pixel counts per print-head third
      packet[3] = counts[1];
      packet[4] = counts[2];
      packet[5] = 1; // repeat = 1
      packet.set(line, 6);
      const frame = new NiimbotPacket(RequestCode.PRINT_BITMAP_ROW, packet).toBytes();
      for (const b of frame) frames.push(b);
    }
    await this.transport.send(Uint8Array.from(frames));
    log.push(`sent ${bmp.rows} rows (${frames.length} bytes)`);

    await new Promise((r) => setTimeout(r, 300));
    await step('END_PAGE', RequestCode.END_PAGE_PRINT, Uint8Array.of(0x01), 1000);

    // Wait for the head to physically finish before ending the job, otherwise
    // END_PRINT cuts the label off partway. Poll GET_PRINT_STATUS and stop as
    // soon as it reports done. Reply data: [_, page, printPct, feedPct, ...];
    // reaches printPct=feedPct=100 (0x64) when complete. Only accept "done"
    // after first seeing active printing, to ignore a stale 100.
    let sawPrinting = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const resp = await this.transceive(RequestCode.GET_PRINT_STATUS, Uint8Array.of(0x01), 300);
      const printPct = resp && resp.data.length >= 4 ? resp.data[2] : -1;
      const feedPct = resp && resp.data.length >= 4 ? resp.data[3] : -1;
      if (printPct >= 0 && printPct < 100) sawPrinting = true;
      if (sawPrinting && printPct >= 100 && feedPct >= 100) break;
    }

    await step('END_PRINT', RequestCode.END_PRINT, Uint8Array.of(0x01), 1000);

    const replies = this.received.map((p) => `0x${p.type.toString(16)}[${hx(p.data)}]`).join('  ');
    log.push(`all replies: ${replies || 'none'}`);
    return log.join('\n');
  }

  dispose(): void {
    this.unsubscribe();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
  }
}
