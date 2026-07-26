# buzz-fleet

Presence-first liveness board for [buzz](https://github.com/block/buzz) agent fleets.
Answers one question: **is my fleet alive right now** — across agents, and
across communities you don't administer — from a single YAML config and zero
private keys.

v0.1 ships the presence layer only (this repo). See [Non-goals](#non-goals--roadmap)
for what's deliberately out of scope this release.

## Auth model — read this before wiring in a key

**v0.1 needs no keys of any kind, private or otherwise.**

buzz's Nostr relay exposes an HTTP bridge (`POST /query`) that lets a client
bulk-read presence (kind `20001`) for an explicit list of pubkeys in one round
trip, without a WebSocket connection. That endpoint still requires a caller to
identify itself, but on a relay running in its (default, self-hosted) permissive
mode it accepts a bare `X-Pubkey: <64-hex>` header with **no signature** — no
NIP-98 event, no private key, nothing to protect. `callerPubkey` in
`fleet.yaml` is that self-declared label, not a credential. Reusing a public
roster pubkey there (as the shipped example does, with `gatekeeper`'s) is
fine; it proves nothing and unlocks nothing on its own.

Presence itself is unencrypted by design: the relay stores a bare status
string (`online` / `away` / `offline`) in Redis with a 90-second TTL and
synthesizes a relay-signed event from a bulk `MGET` on read. There is nothing
in that payload a key could decrypt, because nothing is encrypted.

This changes in **v0.2**, which reads turn-level telemetry (kind `24200`).
That is NIP-44, owner-key-encrypted, and `#p`-gated per community — v0.2 will
need one owner key *per community you want turn detail for*, referenced from
config by **environment variable name only** (e.g. `ownerKeyEnvVar:
BUZZ_FLEET_OWNER_KEY_MAIN`). The key's actual value never appears in
`fleet.yaml`, never gets committed, and v0.1's config schema has no field for
it at all — there is nothing to leak because there is nothing to hold.

buzz-fleet never claims fleet-wide superuser reads. It sees what the relay's
bridge is willing to hand an unauthenticated (v0.1) or owner-authenticated
(v0.2+) caller, per community, same as any other client.

## How liveness works

The bridge's synthesized presence event is **not** a record of when an agent
last published — its `created_at` is stamped with the request's own wall-clock
time on every read, not the underlying Redis value's age (confirmed by
reading `synthesize_presence` in `buzz-relay` and cross-checked against live
responses: three sequential polls returned strictly increasing `created_at`
values a few seconds apart, matching poll time, not publish time). So
"how long has this been alive" is something buzz-fleet has to track itself,
not something the bridge will tell you:

- Every poll that returns a pubkey marks it **alive** and records **now** as
  that agent's `lastSeenAt`.
- A pubkey **absent** from the response is immediately classified **dead** —
  the relay's own Redis `MGET` already dropped it (key never published, or
  its 90-second TTL lapsed), so there is nothing left to wait out
  client-side. `deadAfterMs` (default `90000`, matching the relay's TTL) is
  used only to flag a currently-alive row as going stale if the next poll is
  overdue, not to re-derive elapsed time from a stamp that doesn't carry it.
- The harness republishes presence every 60 seconds and clears it on graceful
  shutdown; `pollIntervalMs` (default `20000`) polls comfortably inside that
  window so a miss shows up within one interval, not one TTL cycle.
- "Dead" UI copy stays neutral (never "crashed", "failed", never a warning
  color implying fault) — a closed desktop window kills a fleet's presence
  exactly as innocently as a real crash does
  ([block/buzz#2412](https://github.com/block/buzz/issues/2412)).

Requesting kind `40902` (the relay-signed presence *snapshot* kind) returns
the same synthesized kind-`20001` events as requesting kind `20001` directly —
the bridge normalizes both through the same code path. buzz-fleet always
requests `20001`.

## Config

One YAML file, `public/fleet.yaml` (served as-is by Vite in dev and copied
into the production build):

```yaml
relays:
  - url: http://localhost:3000
    callerPubkey: f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1
    roster:
      - pubkey: f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1
        label: gatekeeper

pollIntervalMs: 20000
deadAfterMs: 90000
```

- `relays[].url` — a buzz relay's HTTP origin (the same host the relay's
  Nostr WebSocket serves, over `http(s)` instead of `ws(s)`).
- `relays[].callerPubkey` — see [Auth model](#auth-model--read-this-before-wiring-in-a-key)
  above. Any well-formed 64-hex string; not secret.
- `relays[].roster[]` — the agents to watch on that relay: `pubkey` (64-hex,
  required) and an optional display `label`.
- `pollIntervalMs` / `deadAfterMs` — see [How liveness works](#how-liveness-works).

Copy `public/fleet.yaml`, add your own roster, restart `npm run dev`. No
other config source (env files, CLI flags, secrets manager) is read for
anything roster- or relay-related in v0.1.

## Run it

```bash
npm install
npm run dev       # board at http://localhost:5173, polling public/fleet.yaml's relay(s)
```

Requires a reachable buzz relay (self-hosted; see
[block/buzz](https://github.com/block/buzz)) with at least one agent
publishing presence. The shipped example config points at a local relay on
`http://localhost:3000` with `gatekeeper`, the demo rig's agent, as the first
roster row.

## Development

```bash
npm run typecheck
npm run lint
npm test              # vitest run
npm run test:coverage # thresholds: 80% lines/functions/branches/statements on src/
```

TDD throughout: presence classification and the bridge poller were built
red-green, with fixtures modeled on the bridge's response shape plus at least
one response captured live from a running relay (`test/fixtures/`).

## Non-goals / roadmap

- **No new Nostr event kinds.** buzz-fleet is a read-only client of what
  buzz already emits.
- **No reply/approve actions.** Read-only keeps this complementary to
  buzz's own approval-flow work, not competing with it.
- **No fleet-wide superuser reads**, ever — see [Auth model](#auth-model--read-this-before-wiring-in-a-key).
- **v0.2**: turn-level ingestion (kind `24200`, owner-key decrypted) and the
  full classifier — `wedged`, `deaf`, `crashed mid-turn`, `swallowed` —
  layered on top of the alive/dead board this repo ships.
- **v0.3**: cost/history panel from kind `44200` and swallowed-reply
  correlation against the channel stream.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
