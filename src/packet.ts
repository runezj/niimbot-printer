/**
 * Niimbot wire packet.
 *
 * Frame: `55 55 <type> <len> <data...> <checksum> AA AA`
 * where checksum = type XOR len XOR every data byte.
 *
 * Protocol references (community reverse-engineering — verify against your printer):
 *  - https://printers.niim.blue/interfacing/proto/
 *  - https://github.com/MultiMote/niimbluelib (per-model print tasks)
 *  - https://github.com/AndBondStyle/niimprint
 */

const HEAD = 0x55;
const TAIL = 0xaa;

export class NiimbotPacket {
  constructor(
    readonly type: number,
    readonly data: Uint8Array
  ) {}

  toBytes(): Uint8Array {
    const len = this.data.length;
    let checksum = this.type ^ len;
    for (const b of this.data) checksum ^= b;

    const out = new Uint8Array(len + 7);
    out[0] = HEAD;
    out[1] = HEAD;
    out[2] = this.type;
    out[3] = len;
    out.set(this.data, 4);
    out[4 + len] = checksum & 0xff;
    out[5 + len] = TAIL;
    out[6 + len] = TAIL;
    return out;
  }

  static fromBytes(buf: Uint8Array): NiimbotPacket {
    if (buf.length < 7) throw new Error('Niimbot packet too short');
    const len = buf[3];
    const data = buf.slice(4, 4 + len);
    return new NiimbotPacket(buf[2], data);
  }
}

/**
 * Incremental parser for the notify stream. BLE notifications can split or
 * coalesce packets, so we buffer and emit whole frames. A frame's total length
 * is `data[3] + 7`.
 */
export class NiimbotPacketParser {
  private buf: number[] = [];

  push(chunk: Uint8Array): NiimbotPacket[] {
    for (const b of chunk) this.buf.push(b);
    const out: NiimbotPacket[] = [];
    // Drop bytes until a valid head, then pull complete frames.
    while (this.buf.length > 4) {
      if (this.buf[0] !== HEAD || this.buf[1] !== HEAD) {
        this.buf.shift();
        continue;
      }
      const frameLen = this.buf[3] + 7;
      if (this.buf.length < frameLen) break;
      const frame = Uint8Array.from(this.buf.slice(0, frameLen));
      this.buf.splice(0, frameLen);
      try {
        out.push(NiimbotPacket.fromBytes(frame));
      } catch {
        // skip malformed frame
      }
    }
    return out;
  }

  reset(): void {
    this.buf = [];
  }
}
