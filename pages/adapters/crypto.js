// Minimal Node crypto surface used by the unchanged session and lobby code.
export function randomBytes(size) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  bytes.toString = (encoding) => {
    if (encoding !== 'hex') throw new Error('Only hex random tokens are supported');
    return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
  };
  return bytes;
}
export function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const range = max - min;
  if (!Number.isSafeInteger(range) || range <= 0 || range > 2 ** 32) throw new RangeError('Invalid range');
  const cap = Math.floor(2 ** 32 / range) * range;
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= cap);
  return min + n % range;
}
