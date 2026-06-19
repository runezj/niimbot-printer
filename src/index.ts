/**
 * niimbot-printer — transport-agnostic core.
 *
 * Bring your own transport (implement `NiimbotTransport`) and drive a printer
 * with `NiimbotPrinter`. Includes QR + caption label rendering. For React
 * Native + BLE, import the ready-made adapter from `niimbot-printer/react-native`.
 */
export type { NiimbotTransport } from './transport';
export { NiimbotPrinter, type PrintOptions } from './printer';
export { NiimbotPacket, NiimbotPacketParser } from './packet';
export { RequestCode, responseCodeFor, u16be } from './commands';
export { bytesToBase64, base64ToBytes } from './base64';
export {
  buildQrLabelBitmap,
  labelDotDimensions,
  DOTS_PER_MM,
  MAX_PRINT_WIDTH_DOTS,
  type MonoBitmap,
  type QrLabelParams,
} from './label/labelBitmap';
