# buzz-fleet

Presence-first liveness board for [buzz](https://github.com/block/buzz) agent fleets.
Answers one question: **is my fleet alive right now** — across agents, and
across communities you don't administer — from a single YAML config and zero
private keys to start.

v0.1 shipped the presence layer (alive/dead, zero keys). v0.2 adds turn-level
telemetry (kind `24200`) and the full six-state classifier — `wedged`,
`crashed-mid-turn`, `deaf`, `swallowed` — layered on top, opt-in per relay via
one owner key. See [The six-state model](#the-six-state-model-v02) and
[Auth model (v0.2)](#auth-model-v02--turn-telemetry) below, and
[Non-goals](#non-goals--roadmap) for what's still deliberately out of scope.

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

## Auth model (v0.2) — turn telemetry

Turn-level detail (kind `24200`, [NIP-AO](https://github.com/block/buzz/blob/main/docs/nips/NIP-AO.md))
is a different trust model from presence, and opt-in per relay:

- **Ephemeral, unreplayable.** Kind `24200` is in the NIP-01 ephemeral range
  (20000–29999); relays never persist it, and a subscription always uses
  `since=<now>` — never a past timestamp, never history. There is nothing to
  "catch up on" after a reconnect, only what arrives from that point forward.
- **NIP-44 v2 encrypted, NIP-42 gated.** `content` is NIP-44-encrypted
  `(agent_privkey, owner_pubkey)`; reading it needs the owner's secret key.
  The WS subscription itself is NIP-42-authed (`{"kinds":[24200],
  "#p":["<owner_pubkey>"], "since":<now>}`) — one connection per relay
  (community), one owner key per relay. There is no fleet-wide or
  cross-community superuser read; an owner key only ever decrypts telemetry
  addressed to that owner, on that relay.
- **Server-side only, by construction.** Reading a NIP-44 payload requires
  the owner's *secret* key, so this cannot run in the browser — bundling a
  secret key into browser JS would ship it to anyone who opens devtools.
  `src/server/turnsDaemon.ts` runs this in Node, inside the `npm run dev`
  process itself (same dev-server-only precedent as the `/relay-proxy` CORS
  workaround below), and hands the *browser* only already-decrypted,
  already-classified state via `/turns-state.json` — never the key, never
  raw ciphertext.
- **Config references the key, never holds it.** Add ONE of
  `relays[].ownerKeyFile` (a file path) or `relays[].ownerKeyEnv` (an
  environment variable NAME) to a relay in `fleet.yaml` to opt that relay
  into turn telemetry. Neither field's value is ever the key itself —
  `ownerKeyEnv`'s parser explicitly rejects anything that looks like an
  actual hex privkey or `nsec1...` key, so pasting a real secret in by
  mistake fails to parse rather than silently working. The daemon reads the
  file/env var at runtime, in-process; the value never appears in `git`,
  never appears in a process's `argv` (ps-visible), and this parser never
  sees it either. A relay with neither field stays exactly what it was in
  v0.1: presence-only, zero keys.
- **`wsUrl`.** The daemon dials a relay's WebSocket directly — unlike the
  browser's HTTP presence poll, it has no CORS to work around, so it never
  needs the `/relay-proxy` path. Set `wsUrl` explicitly when `url` is that
  root-relative proxy path (no real origin to derive one from); omit it
  when `url` is already an absolute `http(s)` origin and the WS endpoint is
  the same host with `ws(s)` swapped in.

**Drift note:** this contract was verified against a `block/buzz` checkout
at commit `b9d5c7c` (`docs/nips/NIP-AO.md`, `crates/buzz-acp/src/{lib,pool,
observer}.rs`, `crates/buzz-relay/src/handlers/event.rs`) — not the exact
sha the ticket names, which wasn't in that checkout's history, but the same
NIP text and the same `outcome_label`/circuit-breaker/elision behavior
described below. Separately: the newest `buzz-relay` builds (`sha-25e7864`)
gate the HTTP bridge's `/query` endpoint behind NIP-98 — irrelevant to this
board's WS-based kind-24200 ingestion, and to the local demo rig's older
relay build, but worth knowing before pointing `buzz-fleet` at a freshly
updated relay: the v0.1 presence poll's `/query` call would need a NIP-98
`Authorization` header it does not currently send.

### Provisioning: an agent with no owner mapping emits nothing

A correctly-implemented board sees *zero* telemetry until the relay knows which
owner an agent belongs to. The relay authorizes every kind-24200 publish against
`users.agent_owner_pubkey`; while that column is NULL the check
(`buzz-db/src/user.rs::is_agent_owner`) matches no row, falls through to
`unwrap_or(false)`, and drops the frame. The failure is silent in both
directions: `buzz-acp`'s publisher is fire-and-forget at the OK-response level,
so the harness logs `relay observer enabled` and no warnings while every frame
is rejected.

The column is provisioned by the relay, not by an operator, and not by any
`buzz`/`buzz-admin` subcommand (neither has one). On an open relay,
`handlers/auth.rs` extracts the owner from a NIP-OA `auth` tag on the signed
NIP-42 AUTH event and calls `materialize_nip_oa_owner` →
`set_agent_owner` (first-write-wins). `buzz-acp` forwards `BUZZ_AUTH_TAG` into
that AUTH event, so minting the tag is the entire provisioning step — see
`scripts/mint-nip-oa-tag.mjs`, which gates itself on NIP-OA's published test
vector before touching real keys.

### `acp_write` frames carry the agent's private key

Observed live, not hypothesised: buzz-acp's `acp_write` frames include the ACP
`session/new` request verbatim, and that request carries `mcpServers[].env` —
which contains the agent's own `BUZZ_PRIVATE_KEY` as a plaintext `nsec`. The
frame is NIP-44 encrypted to the owner, so the relay never sees it, but any
owner-side consumer that logs or renders raw payloads will hold a live secret
key. This board redacts at the decrypt boundary (`src/turns/redact.ts`); any
other integration should assume raw frames are secret-bearing.

### Lifecycle hooks are opt-in

Not a buzz-fleet concern, but it invalidates approval-gate demo recipes: buzz's
MCP-driven lifecycle hooks are **off by default**. Without
`MCP_HOOK_SERVERS='*'` (or a server allowlist) on the agent process, a hook
server starts, is handed to the agent in `session/new`, and is simply never
called — turns close normally and no `_Stop` appears anywhere. Symptom in the
telemetry: `session/new → session/prompt → agent_message_chunk → result` with no
hook call in between.

### Frame kinds seen on the wire

Beyond the four the NIP documents and the twelve-plus the contract lists, this
rig also emitted `session_config_captured` and `session_resolved`, and ACP
traffic surfaced a `_goose/unstable/session/update` method (buzz-agent is
Goose-based). All are handled by the default pass-through path — the point of
treating `kind` as an open string set. `turn_completed` on this relay build
arrived with an empty `{}` payload rather than an `outcome` field, which is why
`FATAL_OUTCOMES` handling must tolerate a missing outcome instead of assuming
`outcome_label` is always present.

## The six-state model (v0.2)

Once a relay has an owner key configured, that relay's agents classify into
six states instead of two (`alive`/`dead`). All six are computed by
`classifySlot`/`rollupAgentState` (`src/turns/classify.ts`) from telemetry +
presence — see that file's fixture tests (`test/turns/classify.test.ts`) for
the exact state machine, timeline by timeline.

| State | Signal |
|---|---|
| `alive` | Presence fresh; no open turn, or one still young/ticking normally. |
| `dead` | Presence absent for >90s (same bound as v0.1). |
| `wedged` | An open turn whose liveness ticks (~10s cadence) are still arriving, well past the point a normal turn would have finished — bounded by the harness's own 7200s hard cap, which eventually force-resolves it one way or another. |
| `crashed-mid-turn` | An open turn whose ticks *stopped*, corroborated by presence going dead or by the turn's own elapsed time crossing the harness's `idle_timeout`(900s)/hard-cap(7200s) bounds — **never by the tick gap alone** (see guardrail below). |
| `deaf` | Presence is fine and the channel is active, but zero *channel-sourced* turns have started in that window — the agent isn't picking up mentions. Corroborated by an unreacted channel message (the harness posts a 👀 reaction on pickup, clears it on completion; a message with neither is the deaf signal). |
| `swallowed` | A channel-sourced turn completed with `outcome=ok`, but no reply ever showed up in that channel afterward ([block/buzz#2698](https://github.com/block/buzz/issues/2698), [#2459](https://github.com/block/buzz/issues/2459)). |

**The hard rule, with its own dedicated tests:** buzz-acp's harness
self-paces publishing at 6/s with a 90-per-rolling-60s cap, and frames the
relay's own rate limiter rejects are dropped *silently* — this client never
sees an error for them, just a gap. A gap in `turn_liveness` ticks is
therefore never, by itself, enough to flip a state — it always needs
corroboration from presence (the process actually going dead) or a turn
timeout (900s/7200s) before `crashed-mid-turn` is reported instead of
`wedged`. See `test/turns/classify.test.ts`'s "silent-drop guardrail" suite.

**Per-slot, not per-process.** A harness managing multiple agent slots
(`agentIndex`) has a circuit breaker per slot: 3 crashes in 60s puts that
one slot into a 300s silent cooldown while its siblings keep working
normally. `classifySlot` is called once per `agentIndex`, so one slot's
cooldown never drags a healthy sibling's state down, and `rollupAgentState`
surfaces the worst slot's state on the agent's main row while `slots`
carries every individual slot's own state and age underneath it.

**What's classified but not yet live-fed:** `deaf` and `swallowed` need
corroboration from the channel message/reaction stream, which is a separate
feed from kind-24200 telemetry (AC2's WS ingestion is telemetry-only). The
classifier fully supports both — fixture-tested — via an optional
`channelActivity` input on `classifySlot`; wiring a live channel/reactions
feed into the daemon so they populate on the running board is out of scope
for this release (no non-goal changed: v0.1's "no reply/approve actions,
read-only" stance is unaffected either way).

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
  - url: /relay-proxy
    wsUrl: ws://localhost:3000
    callerPubkey: f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1
    # ownerKeyEnv: BUZZ_FLEET_OWNER_KEY_MAIN
    roster:
      - pubkey: f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1
        label: gatekeeper

pollIntervalMs: 20000
deadAfterMs: 90000
```

- `relays[].url` — a buzz relay's HTTP origin (the same host the relay's
  Nostr WebSocket serves, over `http(s)` instead of `ws(s)`), **or** a
  root-relative path reached through a same-origin proxy — see
  [Browser CORS](#browser-cors) below for why the shipped example uses one.
- `relays[].callerPubkey` — see [Auth model](#auth-model--read-this-before-wiring-in-a-key)
  above. Any well-formed 64-hex string; not secret.
- `relays[].roster[]` — the agents to watch on that relay: `pubkey` (64-hex,
  required) and an optional display `label`.
- `relays[].ownerKeyFile` / `relays[].ownerKeyEnv` — **v0.2, optional.** See
  [Auth model (v0.2)](#auth-model-v02--turn-telemetry). At most one of the
  two; a file path or an environment variable NAME, never a key value.
  Omit both to stay v0.1 presence-only for that relay.
- `relays[].wsUrl` — **v0.2, optional.** The relay's real WS origin for the
  daemon to dial directly. Required when `url` is a root-relative proxy
  path like the shipped example; derived automatically (scheme swap) when
  `url` is already an absolute `http(s)` origin.
- `pollIntervalMs` / `deadAfterMs` — see [How liveness works](#how-liveness-works).

Copy `public/fleet.yaml`, add your own roster, restart `npm run dev`. No
config source outside this file (CLI flags, secrets manager, anything
else) is read for anything roster- or relay-related. The one exception is
`ownerKeyEnv`'s *target* — that named environment variable is real
process environment, read by the v0.2 daemon, never by this file itself.

## Browser CORS

The relay build used on the local demo rig doesn't emit
`Access-Control-Allow-Origin` on `/query` responses (confirmed against a
running `buzz-prod-relay-1`: both the CORS preflight and the actual POST
response omit it, even with a valid `Origin` header sent). A browser blocks
reading that response as a same-origin-policy violation regardless of which
port buzz-fleet's own dev server runs on — `fetch()` never even reaches the
relay's application logic, so this isn't fixable from buzz-fleet's client
code, and buzz-fleet doesn't patch or reconfigure relay containers.

The shipped `public/fleet.yaml` works around it with `url: /relay-proxy`, a
root-relative path (`loadConfig` accepts either an absolute origin or a
root-relative one). `npm run dev` proxies that path to the real relay
server-side (`vite.config.ts` — plain HTTP, no browser involved, so CORS
doesn't apply). If your relay build sets CORS headers itself, point `url` at
its real origin directly and skip the proxy entirely.

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

To also see turn-level state (v0.2), uncomment `ownerKeyEnv` in
`public/fleet.yaml` and export that environment variable before starting
the dev server:

```bash
export BUZZ_FLEET_OWNER_KEY_MAIN=<your owner secret key, hex or nsec1>
npm run dev
```

The board then polls `/turns-state.json` (served by a `configureServer`
Vite plugin — `src/server/turnsMiddleware.ts` — that starts the daemon on
first request) on top of the existing presence poll. This is dev-server-only,
same as the `/relay-proxy` CORS workaround: `npm run build`'s static output
has no server to run the daemon in.

## Development

```bash
npm run typecheck
npm run lint
npm test              # vitest run
npm run test:coverage # thresholds: 80% lines/functions/branches/statements on src/
```

TDD throughout: presence classification and the bridge poller (v0.1), and
the six-state classifier, NIP-44 decrypt, WS ingestion, and turns daemon
(v0.2), were all built red-green. v0.1 fixtures are modeled on the bridge's
response shape plus at least one response captured live from a running
relay (`test/fixtures/`). v0.2's classifier fixtures are synthetic
timelines (`test/turns/classify.test.ts`) covering all six states, the
silent-drop guardrail, the per-slot circuit breaker, heartbeat-vs-channel
turn sources, and elided payloads; the WS/decrypt layers are tested against
nostr-tools' own real NIP-44/NIP-42 implementations (round-tripped, never
hand-rolled) with a fully in-memory fake relay standing in for the network.

## Non-goals / roadmap

- **No new Nostr event kinds.** buzz-fleet is a read-only client of what
  buzz already emits.
- **No reply/approve actions.** Read-only keeps this complementary to
  buzz's own approval-flow work, not competing with it.
- **No fleet-wide superuser reads**, ever — see [Auth model](#auth-model--read-this-before-wiring-in-a-key)
  and [Auth model (v0.2)](#auth-model-v02--turn-telemetry).
- **Shipped in v0.2**: turn-level ingestion (kind `24200`, NIP-42-authed WS,
  NIP-44 owner-key decrypted) and the full six-state classifier — `wedged`,
  `crashed-mid-turn`, `deaf`, `swallowed` — layered on top of the alive/dead
  board v0.1 shipped. See [The six-state model](#the-six-state-model-v02).
- **Not yet live-fed in v0.2**: `deaf`/`swallowed` need the channel
  message/reaction stream as corroboration, a separate feed from kind-24200
  telemetry — the classifier fully supports it (fixture-tested, pluggable
  `channelActivity` input) but nothing wires a live channel/reactions feed
  into the running daemon yet.
- **v0.3**: cost/history panel from kind `44200`, and that live channel/
  reactions feed for `deaf`/`swallowed`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
