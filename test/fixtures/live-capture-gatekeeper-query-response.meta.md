# Fixture provenance: `live-capture-gatekeeper-query-response.json`

Captured live from the local demo rig, byte-for-byte (single line, exactly as
received — not reformatted).

- **Captured**: 2026-07-25T23:36:38Z
- **Command**:
  ```bash
  curl -sS -X POST "http://localhost:3000/query" \
    -H "Content-Type: application/json" \
    -H "X-Pubkey: f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1" \
    -d '[{"kinds":[20001],"authors":["f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1"]}]'
  ```
- **Relay**: `buzz-prod-relay-1` (`ghcr.io/block/buzz:main`, docker compose,
  `~/dev/buzz-local`), `HTTP 200`, healthy for 33h at capture time.
- **Subject**: `gatekeeper`, the demo rig's `buzz-acp` agent
  (pid confirmed live via `pgrep -f buzz-acp`).
- **Upstream pin**: verified against `block/buzz@c7089d3b52a6758596cb516f7b3e65989428d26b`
  (2026-07-25); `crates/buzz-relay/src/api/bridge.rs::synthesize_presence`
  unchanged from the design brief's `384c72d` pin — see repo evidence in
  MPI-463.

Used by `test/presence/bridge.test.ts` to prove `fetchPresence` parses a real
relay response, not just the modeled shape in `bridge-response-shape.json`
and `bridge-response-mixed-roster.json`.
