/*
  The CRC the ArduPilot bootloader reports for the programmed flash
  (crc32_small in AP_Bootloader, crc_crc32 in AP_Math): the reflected CRC-32
  polynomial 0xEDB88320, the running value passed in and returned as it is,
  with no inversion at either end. ArduPilot's uploader.py computes the same.
*/
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, state = 0): number {
  let c = state >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return c;
}

/** The CRC of a firmware image as the bootloader computes it: the image, then erased flash (0xFF) up to the flash size. */
export function flashCrc(image: Uint8Array, flashSize: number): number {
  let c = crc32(image, 0);
  const pad = new Uint8Array(4).fill(0xff);
  // Whole words of erased flash after the image, as uploader.py: range(len(image), flashSize - 1, 4).
  for (let i = image.length; i < flashSize - 1; i += 4) c = crc32(pad, c);
  return c;
}
