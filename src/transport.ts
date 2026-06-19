/**
 * Transport abstraction. The protocol core only needs to push bytes and receive
 * notification bytes — it doesn't care whether that's BLE, serial, Web
 * Bluetooth, a socket or a mock. Implement this to target a new platform.
 */
export interface NiimbotTransport {
  /** Write raw bytes to the printer (the implementation chunks/paces as needed). */
  send(bytes: Uint8Array): Promise<void>;
  /** Subscribe to inbound notification bytes. Returns an unsubscribe function. */
  onData(listener: (data: Uint8Array) => void): () => void;
}
