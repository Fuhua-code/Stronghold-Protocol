// Shared remote-address validation used by the browser and the local probe endpoint.
export function isLoopbackHost(host = globalThis.location?.hostname) {
  let value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (value.includes(':')) {
    try { value = new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return false; }
  }
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '::' || value === '0.0.0.0') return true;
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  const mapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  return !!mapped && (parseInt(mapped[1], 16) >>> 8) === 0x7f;
}

export function normalizeRemoteUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /[\s\u0000-\u001f\u007f\\<>"'`]/u.test(value)) return null;
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  let url;
  try { url = new URL(explicit ? value : `http://${value}`); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isLoopbackHost(url.hostname)) return null;
  if (url.port === '0') return null;
  const host = url.hostname.replace(/\.$/, '');
  if (/^[\d.]+$/.test(host)) {
    const authority = value.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
    if (authority.split(':')[0] !== host) return null;
  } else {
    const labels = host.split('.');
    if (labels.length < 2 || host.length > 253 || !labels.every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) return null;
    if (!/^(?:[a-z]{2,63}|xn--[a-z\d-]+)$/i.test(labels.at(-1))) return null;
  }
  return url.toString();
}
