/** Browser- and server-safe SHA-256 for deterministic contract identities. */
export function sha256(value: string | Uint8Array): string {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const constants: number[] = [];
  for (let candidate = 2; constants.length < 64; candidate += 1) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) constants.push(((Math.cbrt(candidate) % 1) * 0x1_0000_0000) >>> 0);
  }

  let hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64);
  const rotateRight = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15]!;
      const second = words[index - 2]!;
      words[index] =
        ((rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3)) +
          words[index - 16]! +
          (rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10)) +
          words[index - 7]!) >>>
        0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const first =
        (h! +
          (rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)) +
          ((e! & f!) ^ (~e! & g!)) +
          constants[index]! +
          words[index]!) >>>
        0;
      const second =
        ((rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)) +
          ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash = hash.map((word, index) => (word + [a, b, c, d, e, f, g, h][index]!) >>> 0);
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
