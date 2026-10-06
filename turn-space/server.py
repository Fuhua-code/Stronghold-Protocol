"""Short-lived FastRTC TURN credential broker for the static Pages client."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock


HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "7860"))
FASTRTC_URL = "https://turn.fastrtc.org/credentials"
ALLOWED_ORIGIN = "https://fuhua-code.github.io"
MIN_TTL = 300
MAX_TTL = 1800
RATE_WINDOW = 60
RATE_LIMIT = 30
rate_lock = Lock()
rate_state: dict[str, list[float]] = {}


def json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def valid_ice_servers(value: object) -> bool:
    if not isinstance(value, list) or not value:
        return False
    has_turn = False
    for server in value:
        if not isinstance(server, dict):
            continue
        urls = server.get("urls")
        urls = urls if isinstance(urls, list) else [urls]
        urls = [url for url in urls if isinstance(url, str) and url.startswith(("stun:", "stuns:", "turn:", "turns:"))]
        if not urls:
            continue
        turn_urls = [url for url in urls if url.startswith(("turn:", "turns:"))]
        if turn_urls:
            if not isinstance(server.get("username"), str) or not server["username"]:
                continue
            if not isinstance(server.get("credential"), str) or not server["credential"]:
                continue
            has_turn = True
    return has_turn


def request_credentials(ttl: int) -> dict:
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise RuntimeError("HF_TOKEN is not configured")
    query = urllib.parse.urlencode({"ttl": str(ttl)})
    request = urllib.request.Request(
        f"{FASTRTC_URL}?{query}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            body = json.loads(response.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("FastRTC credential service unavailable") from error
    if not valid_ice_servers(body.get("iceServers")):
        raise RuntimeError("FastRTC returned invalid TURN credentials")
    return {
        "iceServers": body["iceServers"],
        "expiresAt": int(time.time() * 1000) + ttl * 1000,
    }


def allow_request(address: str) -> bool:
    now = time.monotonic()
    with rate_lock:
        values = [stamp for stamp in rate_state.get(address, []) if now - stamp < RATE_WINDOW]
        if len(values) >= RATE_LIMIT:
            rate_state[address] = values
            return False
        values.append(now)
        rate_state[address] = values
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "StrongholdTurn/1"

    def origin(self) -> str | None:
        value = self.headers.get("Origin")
        return value if value == ALLOWED_ORIGIN else None

    def send_json(self, status: int, body: object, *, origin: str | None = None) -> None:
        data = json_bytes(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.origin()
        if origin:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.end_headers()
        else:
            self.send_json(403, {"error": "origin_not_allowed"})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        origin = self.origin()
        if parsed.path == "/healthz":
            self.send_json(200, {"ok": True, "provider": "fastrtc-cloudflare-turn", "defaultTtl": 600}, origin=origin)
            return
        if parsed.path != "/credentials":
            self.send_json(404, {"error": "not_found"}, origin=origin)
            return
        if not origin:
            self.send_json(403, {"error": "origin_not_allowed"})
            return
        if not allow_request(self.client_address[0]):
            self.send_json(429, {"error": "rate_limited"}, origin=origin)
            return
        try:
            raw_ttl = int(urllib.parse.parse_qs(parsed.query).get("ttl", ["600"])[0])
        except (TypeError, ValueError):
            raw_ttl = 0
        if not MIN_TTL <= raw_ttl <= MAX_TTL:
            self.send_json(400, {"error": "invalid_ttl", "min": MIN_TTL, "max": MAX_TTL}, origin=origin)
            return
        try:
            result = request_credentials(raw_ttl)
        except RuntimeError:
            # Deliberately generic: never disclose the upstream response or secret state.
            self.send_json(503, {"error": "turn_unavailable"}, origin=origin)
            return
        self.send_json(200, result, origin=origin)

    def log_message(self, format: str, *args: object) -> None:
        # Do not log query strings, headers, or upstream credentials.
        return


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
