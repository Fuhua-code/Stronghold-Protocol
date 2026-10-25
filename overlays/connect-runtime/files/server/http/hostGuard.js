// The embedded server is reached as loopback or as one of its own LAN addresses. Requiring the
// Host header to name the socket's local address blocks DNS-rebinding hosts while keeping
// localhost/LAN play working.
function splitHost(value) {
  const header = String(value || '').trim().toLowerCase();
  if (!header) return null;
  if (header.startsWith('[')) {
    const end = header.indexOf(']');
    if (end < 0) return null;
    const host = header.slice(1, end);
    const rest = header.slice(end + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : '';
    return { host, port };
  }
  const first = header.indexOf(':');
  const last = header.lastIndexOf(':');
  if (first > 0 && first === last) return { host: header.slice(0, first), port: header.slice(first + 1) };
  return { host: header, port: '' };
}

export function isLocalHostHeader(req) {
  const parsed = splitHost(req?.headers?.host);
  if (!parsed) return true; // HTTP/1.0 or a test client without Host
  const local = String(req?.socket?.localAddress || '').toLowerCase().replace(/^\[|\]$/g, '');
  const localPort = String(req?.socket?.localPort || '');
  if (localPort && parsed.port !== localPort) return false;
  if (parsed.host === 'localhost' || parsed.host === '::1') return true;
  if (parsed.host === local) return true;
  if (parsed.host.startsWith('::ffff:') && parsed.host.slice(7) === local) return true;
  if (local.startsWith('::ffff:') && local.slice(7) === parsed.host) return true;
  return false;
}
