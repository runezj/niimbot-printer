# niimbot-printer

Print labels on **Niimbot** thermal label printers from JavaScript/TypeScript.

- **Transport-agnostic core** — protocol + QR/text label rendering. Bring any
  transport (BLE, Web Bluetooth, serial, socket, a mock…).
- **React Native BLE adapter** — ready-made transport using `react-native-ble-plx` (Android only).
- **No canvas/DOM** — labels are rendered from the QR module matrix and a built-in
  5×7 font, so it works in React Native / Node without native image libs.

Tested on the **Niimbot B1**. Other models use slightly different command
formats (see [Protocol notes](#protocol-notes)); the core is structured so they
can be added.

> Reverse-engineered protocol (thanks to [niimbluelib](https://github.com/MultiMote/niimbluelib),
> [niimprint](https://github.com/AndBondStyle/niimprint), and the
> [NIIMBOT community wiki](https://printers.niim.blue/)). Not affiliated with NIIMBOT.

## Install

```sh
npm install niimbot-printer
# For the React Native adapter (Android only; needs a custom dev build, not Expo Go):
npm install react-native-ble-plx
```

## Quick start (React Native + BLE)

```ts
import {
  scanForPrinters,
  requestBlePermissions,
  printQrLabel,
} from 'niimbot-printer/react-native';

await requestBlePermissions();

// 1. Find the printer
const devices = [];
await scanForPrinters((d) => devices.push(d)); // { id, name }

// 2. Print a 50×30 mm QR label with a caption
const log = await printQrLabel({
  deviceId: devices[0].id,
  value: 'https://example.com/item/123',
  text: 'ITEM-123',
  widthMm: 50,
  heightMm: 30,
  density: 3, // 1–5
});
console.log(log); // step-by-step diagnostic log
```

`printQrLabel` connects, renders, prints one label, and disconnects.

## Core usage (your own transport / image)

Implement `NiimbotTransport` and drive `NiimbotPrinter` directly:

```ts
import { NiimbotPrinter, buildQrLabelBitmap, labelDotDimensions } from 'niimbot-printer';

const transport = {
  async send(bytes) { /* write bytes to the printer */ },
  onData(listener) { /* subscribe to notifications */ return () => {}; },
};

const { cols, rows } = labelDotDimensions(50, 30);     // mm → dots (203 dpi)
const bmp = buildQrLabelBitmap({ value: 'hello', text: 'HELLO', cols, rows });

const printer = new NiimbotPrinter(transport);
try {
  await printer.printBitmap(bmp, { density: 3, labelType: 1 });
} finally {
  printer.dispose();
}
```

`buildQrLabelBitmap` returns a `MonoBitmap` (`{ rows, cols, bytesPerRow, data }`,
1 bit = ink, MSB first). You can also build your own bitmap and pass it to
`printBitmap` — the QR/text rendering is optional.

## Diagnostics

When bringing up a new printer, `runDiagnostics(deviceId)` dumps the BLE
service/characteristic table and whether the printer answers a probe — far
easier than logcat:

```ts
import { runDiagnostics } from 'niimbot-printer/react-native';
console.log(await runDiagnostics(deviceId));
```

## Protocol notes

Hard-won details (these cost a lot of debugging on the B1):

- **BLE channel:** the data characteristic is the vendor service
  `e7810a71-…` / char `bef8d6c9-…` (one char does write-without-response *and*
  notify). Never the standard GATT `0x2A00` Device Name.
- **B1 commands:** `PrintStart` is **7 bytes** (`printStart7b`) and `SetPageSize`
  is **6 bytes** (`rows, cols, copies` — not a 4-byte SetDimension + SetQuantity).
  The printer *acks the wrong formats* but then prints blank.
- **Row counts:** each bitmap-row header carries black-pixel counts per third of
  the print head. Sending zeros makes the B1 treat every row as empty (blank label).
- **Delivery:** write-without-response has no backpressure — pace the chunks or
  Android drops image rows (only the top of the label prints).
- **Finish:** poll `GET_PRINT_STATUS` until `printPct = feedPct = 100` before
  `PrintEnd`, or the label is cut off partway.

`printBitmap()` returns a step-by-step log of every command + the printer's
replies, which is the fastest way to debug a new model.

## Building / publishing

```sh
npm install      # installs qrcode + RN peer deps for type-checking
npm run build    # tsc → dist/ (CJS + .d.ts)
npm publish
```
