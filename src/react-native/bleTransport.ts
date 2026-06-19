/**
 * React Native BLE transport for Niimbot printers (react-native-ble-plx).
 *
 * react-native-ble-plx is a native module, so it only exists in a custom dev
 * build (not Expo Go). Everything here lazy-loads it and degrades gracefully:
 * `isNiimbotBleAvailable()` returns false when the module isn't linked.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import { base64ToBytes, bytesToBase64 } from '../base64';
import type { NiimbotTransport } from '../transport';

// Standard Bluetooth SIG services (Generic Access 0x1800, etc.) use this base
// UUID suffix. The printer's data channel is a vendor 128-bit service, so we
// must never pick GAP/GATT characteristics like Device Name (0x2A00).
const SIG_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

// Niimbot BLE serial service + characteristic (as used by NiimBlue). One
// characteristic handles both write-without-response and notify.
const NIIMBOT_SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';

export type NiimbotDevice = {
  id: string;
  name: string | null;
};

type BlePlx = typeof import('react-native-ble-plx');
type BleManager = import('react-native-ble-plx').BleManager;
type Device = import('react-native-ble-plx').Device;
type Characteristic = import('react-native-ble-plx').Characteristic;

let blePlx: BlePlx | null | undefined;
let manager: BleManager | null = null;

function loadBlePlx(): BlePlx | null {
  if (blePlx !== undefined) return blePlx;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blePlx = require('react-native-ble-plx') as BlePlx;
  } catch {
    blePlx = null;
  }
  return blePlx;
}

export function isNiimbotBleAvailable(): boolean {
  return Platform.OS === 'android' && loadBlePlx() != null;
}

function getManager(): BleManager {
  const plx = loadBlePlx();
  if (!plx) throw new Error('Bluetooth module not available (needs a dev build).');
  if (!manager) manager = new plx.BleManager();
  return manager;
}

/** Android 12+ needs BLUETOOTH_SCAN/CONNECT; older needs location. */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const sdk = parseInt(String(Platform.Version), 10);
  const perms: string[] =
    sdk >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(perms as never[]);
  return perms.every((p) => result[p as never] === PermissionsAndroid.RESULTS.GRANTED);
}

async function waitForPoweredOn(mgr: BleManager, timeoutMs = 5000): Promise<void> {
  const state = await mgr.state();
  if (state === 'PoweredOn') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new Error('Bluetooth is off. Enable Bluetooth and try again.'));
    }, timeoutMs);
    const sub = mgr.onStateChange((s) => {
      if (s === 'PoweredOn') {
        clearTimeout(timer);
        sub.remove();
        resolve();
      }
    }, true);
  });
}

/**
 * Scan for nearby named BLE devices (printers advertise a name). Calls
 * `onDevice` as they're found; resolves after `durationMs`.
 */
export async function scanForPrinters(
  onDevice: (device: NiimbotDevice) => void,
  durationMs = 6000
): Promise<void> {
  const mgr = getManager();
  await waitForPoweredOn(mgr);
  const seen = new Set<string>();

  return new Promise<void>((resolve, reject) => {
    mgr.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        mgr.stopDeviceScan();
        reject(error);
        return;
      }
      if (!device || seen.has(device.id)) return;
      const name = device.name ?? device.localName ?? null;
      if (!name) return; // unnamed devices are rarely the printer
      seen.add(device.id);
      onDevice({ id: device.id, name });
    });

    setTimeout(() => {
      mgr.stopDeviceScan();
      resolve();
    }, durationMs);
  });
}

/** A vendor (non-SIG-base) characteristic — i.e. not standard GAP/GATT. */
function isVendorChar(c: Characteristic): boolean {
  return !c.serviceUUID.toLowerCase().endsWith(SIG_BASE_SUFFIX);
}

function pickCharacteristics(chars: Characteristic[]): { write: Characteristic; notify: Characteristic } {
  // Only consider the printer's vendor service(s); never the standard GATT ones.
  const vendor = chars.filter(isVendorChar);
  const pool = vendor.length ? vendor : chars;

  const isNiimbot = (c: Characteristic) => c.serviceUUID.toLowerCase() === NIIMBOT_SERVICE;
  // Prefer the known Niimbot service; otherwise take whatever vendor char fits.
  const niimbotFirst = (a: Characteristic, b: Characteristic) =>
    (isNiimbot(b) ? 1 : 0) - (isNiimbot(a) ? 1 : 0);

  const writable = pool
    .filter((c) => c.isWritableWithoutResponse || c.isWritableWithResponse)
    .sort(niimbotFirst);
  const notifiable = pool.filter((c) => c.isNotifiable || c.isIndicatable).sort(niimbotFirst);

  if (!writable[0]) throw new Error('No writable characteristic found on printer.');
  if (!notifiable[0]) throw new Error('No notify characteristic found on printer.');
  return { write: writable[0], notify: notifiable[0] };
}

function charProps(c: Characteristic): string {
  return (
    [
      c.isReadable && 'R',
      c.isWritableWithResponse && 'W',
      c.isWritableWithoutResponse && 'Wn',
      c.isNotifiable && 'N',
      c.isIndicatable && 'I',
    ]
      .filter(Boolean)
      .join('/') || '-'
  );
}

const shortUuid = (u: string) => (u.length >= 8 ? u.slice(4, 8) : u);

/** A connected printer. Implements {@link NiimbotTransport} for NiimbotPrinter. */
export class NiimbotConnection implements NiimbotTransport {
  private chunkSize: number;
  /** Delay after each write-without-response chunk so the BLE buffer drains. */
  private writePaceMs = 20;

  constructor(
    private readonly device: Device,
    private readonly write: Characteristic,
    private readonly notify: Characteristic,
    private readonly mtu: number,
    private readonly allChars: Characteristic[] = []
  ) {
    // Send near the negotiated MTU: the printer prints in real time, so the
    // image must arrive fast or the head outruns the data and the page ends
    // early (only the top of the label prints).
    this.chunkSize = Math.max(20, mtu - 3);
  }

  get writeChunkSize(): number {
    return this.chunkSize;
  }

  /** Human-readable BLE table for diagnostics (no logcat needed). */
  describe(): string {
    const lines = [
      `MTU: ${this.mtu}`,
      `Write: ${shortUuid(this.write.serviceUUID)}/${shortUuid(this.write.uuid)} [${charProps(
        this.write
      )}] -> ${this.write.isWritableWithResponse ? 'acknowledged' : 'no-response (paced)'}`,
      `Notify: ${shortUuid(this.notify.serviceUUID)}/${shortUuid(this.notify.uuid)} [${charProps(this.notify)}]`,
      `Services/characteristics (${this.allChars.length}):`,
    ];
    for (const c of this.allChars) {
      lines.push(`  ${c.serviceUUID}/${c.uuid} [${charProps(c)}]`);
    }
    return lines.join('\n');
  }

  onData(cb: (data: Uint8Array) => void): () => void {
    const sub = this.notify.monitor((error, ch) => {
      if (error || !ch?.value) return;
      cb(base64ToBytes(ch.value));
    });
    return () => sub.remove();
  }

  async send(bytes: Uint8Array): Promise<void> {
    for (let i = 0; i < bytes.length; i += this.chunkSize) {
      const value = bytesToBase64(bytes.subarray(i, i + this.chunkSize));
      // Prefer acknowledged writes (self-pacing); fall back to write-without-
      // response (with a pacing delay, since it has no backpressure and would
      // otherwise flood Android's BLE buffer and silently drop image rows).
      if (this.write.isWritableWithResponse) {
        await this.write.writeWithResponse(value);
      } else {
        await this.write.writeWithoutResponse(value);
        await new Promise((r) => setTimeout(r, this.writePaceMs));
      }
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.device.cancelConnection();
    } catch {
      // already gone
    }
  }
}

export async function connectToPrinter(deviceId: string): Promise<NiimbotConnection> {
  const mgr = getManager();
  await waitForPoweredOn(mgr);

  let device = await mgr.connectToDevice(deviceId, { timeout: 10000 });
  let mtu = 23;
  try {
    device = await device.requestMTU(247);
    mtu = device.mtu ?? 23;
  } catch {
    // keep default MTU; send() will chunk
  }
  device = await device.discoverAllServicesAndCharacteristics();

  const services = await device.services();
  const chars: Characteristic[] = [];
  for (const s of services) {
    chars.push(...(await s.characteristics()));
  }
  const { write, notify } = pickCharacteristics(chars);
  return new NiimbotConnection(device, write, notify, mtu, chars);
}
