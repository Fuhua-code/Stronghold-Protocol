---
title: Stronghold TURN credentials
emoji: 🔒
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# Stronghold TURN credential broker

This Space is a small server-side broker. It keeps `HF_TOKEN` private, calls
FastRTC's short-lived Cloudflare TURN credential endpoint, and returns only the
validated `iceServers` payload to the Pages client. It does not relay WebRTC
traffic and it does not contain game assets.

Set the `HF_TOKEN` Space Secret before starting the Space. The value is never
returned by `/healthz`, `/credentials`, logs, or repository files.
