// Worker ports have no IP address; this also accepts the loopback address supplied by the adapter.
export function isIP(value) {
  if (typeof value !== 'string') return 0;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((n) => Number(n) <= 255)) return 4;
  return value === '::1' ? 6 : 0;
}
