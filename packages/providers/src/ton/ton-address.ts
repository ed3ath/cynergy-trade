/**
 * TON address forms. TonAPI event payloads carry raw `wc:hex` addresses
 * (live-verified 2026-09-21); the rest of the system keys on user-friendly
 * EQ… form. 34 bytes = [tag(0x11 bounceable | 0x51), workchain, 32B hash]
 * + 2B CRC16/XModem, base64url-encoded.
 */

const crc16xmodem = (bytes: Uint8Array): number => {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

/** `0:hex` (or `-1:hex`) → bounceable EQ…/UQ… user-friendly form. */
export function rawToUserFriendly(raw: string): string {
  const i = raw.indexOf(":");
  if (i < 0) return raw; // already user-friendly
  const wc = parseInt(raw.slice(0, i), 10);
  const hash = Buffer.from(raw.slice(i + 1), "hex");
  if (!Number.isInteger(wc) || hash.length !== 32) throw new Error(`bad raw TON address: ${raw}`);
  const payload = Buffer.concat([Buffer.from([0x11, wc & 0xff]), hash]);
  const c = crc16xmodem(payload);
  const crc = Buffer.from([c >> 8, c & 0xff]);
  return Buffer.concat([payload, crc]).toString("base64url");
}

/** EQ…/UQ… → raw `wc:hex`. Accepts raw input unchanged. */
export function userFriendlyToRaw(addr: string): string {
  if (addr.includes(":") && /^-?\d+:[0-9a-fA-F]+$/.test(addr)) return addr.toLowerCase();
  const buf = Buffer.from(addr.replace(/=+$/, ""), "base64url");
  if (buf.length !== 36) throw new Error(`bad TON address: ${addr}`);
  const wc = buf[1] === 0xff ? -1 : buf[1];
  return `${wc}:${buf.subarray(2, 34).toString("hex")}`;
}

/** Any TON address form → raw `wc:hex` (lowercase) for comparison. */
export function normalizeTonAddress(addr: string): string {
  return userFriendlyToRaw(addr.trim());
}
