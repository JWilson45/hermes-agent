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

## Mini-app cards (opt-in)

Photon **mini apps** are live web cards rendered inside iMessage. Sending is
disabled by default and requires a fail-closed policy file.

### Policy file

`$HERMES_HOME/photon-mini-apps.json` (default `~/.hermes/photon-mini-apps.json`; override: `PHOTON_MINI_APPS_CONFIG`),
mode `0600`, exactly two keys:

```json
{
  "allowedSpaces": ["any;-;+<E164 phone>"],
  "allowedUrlPrefixes": ["https://your-host.example/app"]
}
```

- Opened, permission-checked, and read on every request — edits hot-reload
  without a restart.
- **Fail closed**: missing, unreadable, malformed, wrong-schema, empty, or
  group/other-readable file ⇒ `503 mini-app policy unavailable`. Nothing is
  sent until a valid owner-only policy exists.
- Spaces must match an entry **exactly** (no trimming/normalization); card
  URLs must be credential-free HTTPS URLs matching an allowed origin and path
  boundary. An `/app` prefix allows `/app` and `/app/...`, not `/application`.

### `POST /send-mini-app`

Gate: `PHOTON_MINI_APPS=true` (exact string). Body: `{"spaceId", "url"}`
(strict — extra keys rejected). Sends a **live** mini-app card via the SDK's
`app(url, { live: true })` builder. Multiple sends are allowed, bounded by a
sliding-window rate limit (default 10/min; `PHOTON_MINI_APP_RATE_LIMIT`,
`PHOTON_MINI_APP_RATE_WINDOW_MS`). Rejected requests never consume budget.
Provider errors are redacted (they can contain capability URLs): the response
is a generic non-retryable `500`, and resolver errors log no recipient ids.
A send that resolves without a confirmed message ID also returns a non-retryable
`500`: its delivery outcome is uncertain, so do not retry blindly.

With the gateway running, send through Hermes using:

```sh
hermes photon send-mini-app --to '<space-id>' --url 'https://your-host.example/app'
```

The exact space and URL must be permitted by the active profile's policy. An
accepted send does not prove recipient rendering or delivery.

### Interaction return path

This connector only sends cards. Button presses are not returned to Hermes;
app hosting and authenticated interaction handling are outside its scope. Do
not expose the sidecar token to a browser or callback service. An allowlisted
recipient or URL does not authenticate a button press or prevent replay.

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
