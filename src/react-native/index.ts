/**
 * niimbot-printer/react-native — React Native + BLE adapter.
 *
 * Re-exports the transport-agnostic core plus a ready-made BLE transport and
 * convenience helpers (`printQrLabel`, `runDiagnostics`).
 *
 * Requires `react-native` and `react-native-ble-plx` (peer deps; native module,
 * so a custom dev build — not Expo Go). Android only.
 */
import {
  connectToPrinter,
  isNiimbotBleAvailable,
  requestBlePermissions,
  scanForPrinters,
  type NiimbotDevice,
} from './bleTransport';
import { NiimbotPrinter } from '../printer';
import { NiimbotPacket } from '../packet';
import { buildQrLabelBitmap, labelDotDimensions, type MonoBitmap } from '../label/labelBitmap';

export * from '../index';
export {
  connectToPrinter,
  NiimbotConnection,
  scanForPrinters,
  requestBlePermissions,
  isNiimbotBleAvailable,
  type NiimbotDevice,
} from './bleTransport';

export class NiimbotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NiimbotUnavailableError';
  }
}

export type PrintQrLabelParams = {
  deviceId: string;
  value: string;
  text?: string;
  widthMm: number;
  heightMm: number;
  density: number;
  rotate180?: boolean;
  /** Niimbot label type: 1 = with gaps (die-cut), the common roll. */
  labelType?: number;
  /** Copies (default 1). */
  quantity?: number;
};

/**
 * Build a QR (+ optional caption) label for the given mm size, connect, print,
 * then disconnect. Returns a step-by-step diagnostic log.
 */
export async function printQrLabel(params: PrintQrLabelParams): Promise<string> {
  if (!isNiimbotBleAvailable()) {
    throw new NiimbotUnavailableError(
      'Niimbot printing needs a development build with react-native-ble-plx (not Expo Go), Android only.'
    );
  }
  if (!params.deviceId) {
    throw new NiimbotUnavailableError('Select a Niimbot printer first.');
  }

  const { cols, rows } = labelDotDimensions(params.widthMm, params.heightMm);
  const bmp: MonoBitmap = buildQrLabelBitmap({
    value: params.value,
    text: params.text,
    cols,
    rows,
    rotate180: params.rotate180,
  });

  const conn = await connectToPrinter(params.deviceId);
  const printer = new NiimbotPrinter(conn);
  try {
    return await printer.printBitmap(bmp, {
      density: params.density,
      labelType: params.labelType ?? 1,
      quantity: params.quantity ?? 1,
    });
  } finally {
    printer.dispose();
    await conn.disconnect();
  }
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/**
 * Connect and report the BLE layout + whether the printer answers a probe.
 * Handy for debugging a new printer without logcat.
 */
export async function runDiagnostics(deviceId: string): Promise<string> {
  if (!isNiimbotBleAvailable()) {
    throw new NiimbotUnavailableError('Bluetooth module not available (needs a dev build).');
  }
  if (!deviceId) throw new NiimbotUnavailableError('Select a printer first.');

  const conn = await connectToPrinter(deviceId);
  try {
    const received: string[] = [];
    const off = conn.onData((b) => received.push(toHex(b)));

    // HEARTBEAT (0xDC) then GET_INFO device-serial (0x40, key 11): both should
    // trigger a notification if we're talking on the right characteristics.
    await conn.send(new NiimbotPacket(0xdc, Uint8Array.of(0x01)).toBytes());
    await new Promise((r) => setTimeout(r, 700));
    await conn.send(new NiimbotPacket(0x40, Uint8Array.of(11)).toBytes());
    await new Promise((r) => setTimeout(r, 700));
    off();

    return [
      conn.describe(),
      '',
      `Probe replies: ${received.length ? received.join('  |  ') : 'NONE — printer did not answer'}`,
    ].join('\n');
  } finally {
    await conn.disconnect();
  }
}
