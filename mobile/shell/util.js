// mobile/shell/util.js — small helpers shared by the connect shell (mobile-connect-0.2).
//
// The shell is the page the APK opens for a *local* entry (`http://127.0.0.1:<port>/connect`). It offers two
// entries: 本地 (this phone's server, the default behaviour) and 远程 (a game reachable at a link — a LAN host, a
// tunnel, a VPS). See mobile/shell/README.md and the root README for the flow.

/** True when the page is served from the machine itself (loopback) — the "本机" case of the spec. */
export function isLoopbackHost(host = location.hostname) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^\[?::ffff:127\./.test(h)) return true;
  return false;
}

/**
 * Accepts what a player may paste: `host:port`, `host`, `http(s)://…`, a full game link with `?room=KEY`, or a
 * bare 4-letter alliance key. Returns the absolute URL to open, or null when the text cannot be a link at all.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // strip characters that come along when copying from a chat: quotes, angle brackets, trailing punctuation
  s = s.replace(/^[<"'“”‘’\s]+|[>"'“”‘’\s]+$/g, '');
  if (/^[A-Za-z]{4}$/.test(s)) return null;          // a bare room key is not a link (see the spec: links only)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^[\w.-]+(:\d+)?(\/|$)/.test(s)) return null;
    s = `http://${s}`;
  }
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (!/^[\w.-]+$/.test(url.hostname) && url.hostname[0] !== '[') return null;
  return url.toString();
}

/**
 * Probe a link. `fetch` with `mode: 'no-cors'` cannot read the body, but it does tell us apart the two cases the
 * spec cares about: a server that answered (opaque response) and a link that could not be opened at all (a network
 * error — wrong host, refused port, a firewall or a domain authentication page that never answers).
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ reachable: boolean, blocked: boolean, status: number|null, reason: string }>}
 */
export async function probeLink(url, timeoutMs = 8000) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { mode: 'no-cors', redirect: 'follow', cache: 'no-store', signal: ctrl?.signal });
    return { reachable: true, blocked: false, status: res.type === 'opaque' ? null : res.status, reason: res.type };
  } catch (e) {
    // A `no-cors` fetch rejects for: DNS failure, connection refused, TLS error, … and for a firewall/portal that
    // drops the connection. Both mean "we cannot use this in the app on our own" → the player verifies it.
    const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
    return { reachable: false, blocked: true, status: null, reason: aborted ? 'timeout' : (e?.message || 'network error') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The Android bridge registered by MainActivity as `window.SP_BRIDGE` (`@JavascriptInterface`), or null when the
 * page runs in a plain browser. A JS interface is used rather than an injected `window.__SP_ANDROID__` object
 * because it exists before any page script runs — no injection timing to get wrong.
 */
export const android = (typeof window !== 'undefined' && window.SP_BRIDGE) || null;

/** Whether this page is running inside the APK (as opposed to a browser on the same machine). */
export const inApp = () => {
  try { return !!(android && android.isApp()); } catch { return false; }
};

/** `local` (play here) or `remote` (the app was opened for a link). Never throws. */
export const appMode = () => {
  try { return (android && android.mode && android.mode()) || 'local'; } catch { return 'local'; }
};
