# Photon sidecar

Small Node helper that bridges Hermes Agent to Photon's Spectrum SDK
(`spectrum-ts`).  Hermes is Python; Photon has no public HTTP
send-message endpoint today; replies therefore go through this sidecar.

The sidecar:

- runs `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })`
- exposes a loopback-only HTTP control channel for the Python adapter
  to push send/typing requests (auth via `X-Hermes-Sidecar-Token`)
- drains the inbound message stream so `spectrum-ts` keeps its
  reconnect/heartbeat machinery alive and Hermes can receive inbound messages
  over the adapter's loopback `GET /inbound` stream

## Install

```bash
cd plugins/platforms/photon/sidecar
npm install
```

The Hermes plugin's `hermes photon setup` command runs `npm install`
here automatically.

## Run standalone

For debugging:

```bash
PHOTON_PROJECT_ID=... PHOTON_PROJECT_SECRET=... \
PHOTON_SIDECAR_PORT=8789 PHOTON_SIDECAR_TOKEN=$(openssl rand -hex 16) \
node index.mjs
```

In normal use, the Python adapter supervises this process — start,
restart on crash, kill on shutdown — and never asks the user to run
it by hand.

## Mini-app cards and interaction injection (opt-in)

Two extra routes support Photon **mini apps** (live web cards rendered inside
iMessage). Both are **disabled by default** and share one fail-closed policy
file.

### Policy file

`~/.hermes/photon-mini-apps.json` (override: `PHOTON_MINI_APPS_CONFIG`),
mode `0600`, exactly two keys:

```json
{
  "allowedSpaces": ["any;-;+<E164 phone>"],
  "allowedUrlPrefixes": ["https://your-host.example/app"]
}
```

- Read per-request with an mtime/size/inode cache — edits hot-reload, no
  restart. Permission bits are re-checked on every request.
- **Fail closed**: missing, unreadable, malformed, wrong-schema, empty, or
  group/other-readable file ⇒ `503 mini-app policy unavailable`. Nothing is
  sent or injected until a valid owner-only policy exists.
- Spaces must match an entry **exactly** (no trimming/normalization); card
  URLs must be `https`, credential-free, and **start with** an allowed prefix.

### `POST /send-mini-app`

Gate: `PHOTON_MINI_APPS=true` (exact string). Body: `{"spaceId", "url"}`
(strict — extra keys rejected). Sends a **live** mini-app card via the SDK's
`app(url, { live: true })` builder. Multiple sends are allowed, bounded by a
sliding-window rate limit (default 10/min; `PHOTON_MINI_APP_RATE_LIMIT`,
`PHOTON_MINI_APP_RATE_WINDOW_MS`). Rejected requests never consume budget.
Provider errors are redacted (they can contain capability URLs): the response
is a generic non-retryable `500`, and resolver errors log no recipient ids.

### `POST /inject`

Gate: `PHOTON_INJECT_ENABLED=true` (exact string). Body: `{"spaceId", "text"}`
(strict). The mini-app interaction return path: a button press in the card
hits your own callback server, which forwards here. The sidecar synthesizes
an inbound event in exactly the shape `normalizeEvent()` produces for a real
DM text message (`messageId: inject-<uuid>`, `platform: "iMessage"`,
`space: {id, type: "dm", phone}`, `sender`, `content: {type: "text", text}`,
ISO timestamp) and pushes it onto the same `GET /inbound` NDJSON stream the
adapter consumes — Hermes sees an ordinary inbound message from an approved
chat and can reply.

Safety: same policy allowlist (exact space match), text ≤ 500 chars
(`PHOTON_INJECT_MAX_TEXT`), no C0/C1 control chars or U+FFFC, sliding rate
limit (default 10/min; `PHOTON_INJECT_RATE_LIMIT`,
`PHOTON_INJECT_RATE_WINDOW_MS`), and a **consumer-present check**: with no
adapter attached to `/inbound` the route returns `503` and never queues.
Synthetic events deliberately do not touch stream-health/yield tracking, so
an inject can never mask a zombie upstream gRPC stream.

The callback server itself (button → text mapping, hosting the mini app) is
deployment-specific and not part of this plugin; `/inject` is the generic,
allowlisted return path it posts to.

## Tests

The sidecar's node tests spawn the real `index.mjs` against a mock
spectrum-ts transport (the real SDK builders are re-exported; only the
provider/gRPC layer is mocked) and a temp `0600` policy file. All recipient
ids and URLs in the tests are synthetic fixtures.

```bash
just js-install-photon-sidecar   # npm ci --ignore-scripts in sidecar/
just test-photon-sidecar         # node --test sidecar/*.test.mjs
```

## Why a sidecar at all?

Photon's Spectrum send path is exposed through the TypeScript SDK's
`Space.send(...)` API. Hermes is Python, so replies go through this sidecar
until Photon ships a public HTTP send endpoint.

When Photon ships an HTTP send endpoint, the plan is to retire this
sidecar entirely and call it directly from Python.  The plugin's
outbound code path is already isolated behind small helpers
(`_sidecar_send`, `_sidecar_send_richlink`, and `_sidecar_send_attachment` in
`adapter.py`) to make that swap localized.
