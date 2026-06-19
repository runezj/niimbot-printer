/**
 * Niimbot request command codes and helpers, from the documented protocol
 * (printers.niim.blue) and niimbluelib / niimprint.
 */

export const RequestCode = {
  GET_INFO: 0x40,
  GET_RFID: 0x1a,
  HEARTBEAT: 0xdc,
  SET_LABEL_TYPE: 0x23,
  SET_LABEL_DENSITY: 0x21,
  START_PRINT: 0x01,
  END_PRINT: 0xf3,
  START_PAGE_PRINT: 0x03,
  END_PAGE_PRINT: 0xe3,
  ALLOW_PRINT_CLEAR: 0x20,
  SET_DIMENSION: 0x13,
  SET_QUANTITY: 0x15,
  GET_PRINT_STATUS: 0xa3,
  PRINT_BITMAP_ROW: 0x85,
} as const;

/**
 * Most control commands answer with `type === request + 1`; a few answer with
 * `request + 16`.
 */
export const RESPONSE_OFFSET: Record<number, number> = {
  [RequestCode.SET_LABEL_TYPE]: 16,
  [RequestCode.SET_LABEL_DENSITY]: 16,
  [RequestCode.ALLOW_PRINT_CLEAR]: 16,
  [RequestCode.GET_PRINT_STATUS]: 16,
};

export function responseCodeFor(request: number): number {
  return request + (RESPONSE_OFFSET[request] ?? 1);
}

/** Big-endian uint16 helper (one or more values concatenated). */
export function u16be(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  values.forEach((v, i) => {
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}
