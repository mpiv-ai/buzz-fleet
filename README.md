# buzz-fleet

> **Status: experimental test rig and evidence archive. Not a product, and no
> longer taking new standalone features.**
>
> This repo was built at the wrong integration boundary. buzz already owns most
> of the data plane this code recreated: observer ingestion and decryption run
> natively in Tauri (`desktop/src/features/agents/observerRelayStore.ts`),
> active-turn tracking lives in `activeAgentTurnsStore.ts`, working indicators
> in `agentWorkingSignal.ts`, kind `44200` archiving landed upstream in
> [PR #1555](https://github.com/block/buzz/pull/1555), and a native usage UI is
> in flight as [PR #2035](https://github.com/block/buzz/pull/2035). Those all
> predate or parallel this repo; running a separate Node daemon that holds the
> owner secret, opens extra sockets per relay, and keeps its own SQLite store
> duplicates work the desktop app already does with its own identity.
>
> What holds up is the interpretation layer: a single operational diagnosis per
> agent, and rollups across agents and communities. buzz surfaces presence,
> process status, active turns, and activity, but does not yet fold them into
> one health verdict for a fleet. That work belongs upstream in `block/buzz`,
> and it is where new effort goes.
>
> This repo stays public and stays useful for what it is: a working reference
> implementation of the classifier, a fixture and capture archive from real
> relay runs, and a rig for reproducing agent failure modes against a live
> relay. Fixes to keep it running are welcome. New product surface is not.
>
> One compatibility note for anyone reading the auth sections below: the
> zero-key presence path depends on the relay's permissive `X-Pubkey` fallback.
> Hardened relays require NIP-98, and this client does not sign. Verified
> against a relay build at `sha-25e7864`, which returns `401 missing Nostr
> auth` for the same request the permissive rig answers.

Presence-first liveness board for [buzz](https://github.com/block/buzz) agent fleets.
Answers one question: **is my fleet alive right now** — across agents, and
across communities you don't administer — from a single YAML config and zero
private keys to start.

v0.1 shipped the presence layer (alive/dead, zero keys). v0.2 added turn-level
telemetry (kind `24200`) and the full six-state classifier — `wedged`,
`crashed-mid-turn`, `deaf`, `swallowed` — layered on top, opt-in per relay via
one owner key. v0.3 adds a fleet-wide cost/usage panel (kind `44200`,
durable, SQLite-persisted) and live-feeds `swallowed` detection from a real
channel-message stream — the one piece v0.2 shipped fixture-tested but not
wired up. See [The six-state model](#the-six-state-model-v02),
[Auth model (v0.2)](#auth-model-v02--turn-telemetry),
[The cost panel](#the-cost-panel-v03--turn-metrics), and
[Auth model (v0.3)](#auth-model-v03--turn-cost-metrics--channel-messages)
below, and [Non-goals](#non-goals--roadmap) for what's still deliberately
out of scope.

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

**Drift note (v0.3 correction):** the local demo rig's relay container is
`ghcr.io/block/buzz:sha-25e7864` (confirmed via `docker ps`) — it IS the
"newest builds" build named in the paragraph below, not an older one,
despite that paragraph's own wording implying otherwise. Verified
precisely (`gh api repos/block/buzz/compare/...`): `sha-25e7864` is 17
commits ahead of `384c72d` (the v0.3 ticket's own code-contract pin) and 7
commits behind current `block/buzz` main HEAD as of this check. So for v0.3
specifically: the running relay is NEWER than the pinned contract commit,
not older — the opposite of what "local relay is an older build" would
suggest. This doesn't change any v0.3 claim (all v0.3 source citations are
pinned explicitly to `384c72d` regardless — see `docs/teardown2-claims-map.md`),
it just corrects the record on which direction the drift runs.

**Drift note (v0.2, original):** this contract was verified against a `block/buzz` checkout
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

### Treat decrypted frames as secret-bearing

Decrypted observer payloads are pass-through by contract, and pass-through
cannot mean stored verbatim. Configuration-shaped payloads can carry
credentials, so anything that logs, persists, or renders a raw frame should
assume it may hold key material. This board redacts at the decrypt boundary
(`src/turns/redact.ts`) before a payload reaches the ring buffer, the state
file, the UI, or a capture. Any other integration should do the same.

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
| `swallowed` | A channel-sourced turn completed with `outcome=ok`, but no reply ever showed up in that channel afterward ([block/buzz#2698](https://github.com/block/buzz/issues/2698), [#2459](https://github.com/block/buzz/issues/2459)). **Live-fed as of v0.3** — see below. |

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

**What's classified but not yet live-fed:** `deaf` still needs corroboration
from the channel reaction stream (👀 pickup/clear), which this board doesn't
ingest — the classifier fully supports it (fixture-tested) via the optional
`channelActivity.recentMessages` input, but nothing populates that input on
the running board yet. **`swallowed` is live-fed as of v0.3** (see below) —
`deaf` remains the one still-open item, unchanged non-goal from v0.2 (no
reply/approve actions either way).

## The cost panel (v0.3) — turn metrics

Once a relay has an owner key configured (the same one that unlocks the
six-state model), the daemon also ingests kind `44200`
([NIP-AM](https://github.com/block/buzz/blob/main/docs/nips/NIP-AM.md)) — a
**durable**, per-turn token-usage/cost record, one event per completed turn,
NIP-44 encrypted to the owner. Unlike kind `24200`, relays store this kind
(NIP-AM: "stored, append-only, never replaced"), so the daemon can and does
subscribe with a `since` reaching into the past (`connectMetricsStream`'s
`lookbackMs`, default 30 days) — recovering usage history, not just what
arrives from the moment the dev server started.

Decoded records persist to a local SQLite file (`src/cost/store.ts`, default
`data/buzz-fleet-cost.db`, gitignored — built on the runtime's built-in
`node:sqlite`, not a third-party dependency). `stopReason` folds any value
outside `end_turn`/`max_tokens`/`cancelled`/`error`/`unknown` to `"unknown"`
rather than failing to parse (`src/cost/types.ts`'s `foldStopReason`), and no
token-count field is ever summed as if a `null` (harness didn't report it)
meant zero (`src/cost/aggregate.ts`).

The board's cost section (`src/ui/CostPanel.tsx`) shows the fleet-wide
total and a fleet-wide trend (bucketed, currently hourly) as the primary,
always-visible content, with a per-agent breakdown tucked into a collapsed
drill-down underneath. That's a deliberate structural choice, not a
cosmetic one: Block's own desktop app already ships a per-agent local usage
view grouped by `(harness, model)` ([block/buzz#2790](https://github.com/block/buzz/pull/2790)) —
buzz-fleet's reason to exist here is the view that app doesn't have,
cross-agent and cross-community aggregation on the same stream, so that's
what gets the prominent slot. See `docs/teardown2-claims-map.md` row (g)
for the full citation and the caveat that PR #2790 is merged into a
long-lived feature branch, not yet `main`.

## Auth model (v0.3) — turn cost metrics + channel messages

Two more connections open per relay with an owner key configured, alongside
the existing kind-24200 one:

- **Kind 44200** (turn metrics) reuses the exact same NIP-42 auth and
  NIP-44 decrypt machinery as kind 24200 (`src/turns/metricsClient.ts`
  imports the auth/backoff helpers straight from `wsClient.ts`) — same
  owner key, same trust model, no new key material anywhere. The one wire
  difference: NIP-AM's tag layout has no `frame` tag, so this is a
  dedicated connect function, not a branch inside the existing one.
- **Kind 9** (channel messages — swallowed-detection corroboration) opens a
  broad subscription (`{kinds:[9], since}`, no `#h`/`#p` filter — which
  channels are worth watching is discovered dynamically from live turn
  telemetry, not known up front) on the same relay. Content here is
  **never encrypted** — no key is needed to read it, and no
  `trustedAgentPubkeys` allowlist applies at ingestion, since a Nostr
  signature already guarantees authorship; the correlator
  (`src/turns/swallowed.ts`) does the exact-pubkey match at read time. The
  connection still answers a NIP-42 challenge if this relay build happens
  to issue one for kind 9 (some builds gate reads by community membership;
  this rig's open relay does not) — same `onauth` handler as the other
  streams, just possibly never invoked.

**The swallowed corroboration window is 120 seconds**
(`SWALLOWED_CORROBORATION_WINDOW_MS`, `src/turns/swallowed.ts`): how long
after a channel-sourced turn resolves `ok` the board waits for the agent's
own reply message before calling it swallowed rather than merely slow.
Chosen from real rig timing, not a guess — two non-gated smoke-test replies
captured live (`~/dev/buzz-local/fleet-captures-v02/20260726T045832Z_02_smoke_test_channel_messages.json`)
landed 8s and 26s after their triggering mention. 120s is 2×
`DEFAULT_THRESHOLDS.wedgedAfterMs` (60s): if a turn that merely *stayed
open* this long would already read `wedged`, a turn that reported itself
*complete* this long ago with total silence afterward is at least as
suspect — comfortably above both observed real latencies, with margin for
a legitimately slower model or turn.

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

To also see turn-level state (v0.2) AND the cost panel (v0.3) — the same
owner key unlocks both — uncomment `ownerKeyEnv` in `public/fleet.yaml` and
export that environment variable before starting the dev server:

```bash
export BUZZ_FLEET_OWNER_KEY_MAIN=<your owner secret key, hex or nsec1>
npm run dev
```

The board then polls `/turns-state.json` (served by a `configureServer`
Vite plugin — `src/server/turnsMiddleware.ts` — that starts the daemon on
first request) on top of the existing presence poll; the daemon persists
decoded kind-44200 history to `data/buzz-fleet-cost.db` (SQLite, gitignored,
created automatically) as it arrives. This is dev-server-only,
same as the `/relay-proxy` CORS workaround: `npm run build`'s static output
has no server to run the daemon in.

## Development

```bash
npm run typecheck
npm run lint
npm test              # vitest run
npm run test:coverage # thresholds: 80% lines/functions/branches/statements on src/
```

TDD throughout: presence classification and the bridge poller (v0.1), the
six-state classifier, NIP-44 decrypt, WS ingestion, and turns daemon (v0.2),
and the cost panel, kind-44200 parsing/aggregation/persistence, and
swallowed correlator (v0.3), were all built red-green. v0.1 fixtures are
modeled on the bridge's response shape plus at least one response captured
live from a running relay (`test/fixtures/`). v0.2's classifier fixtures are
synthetic timelines (`test/turns/classify.test.ts`) covering all six
states, the silent-drop guardrail, the per-slot circuit breaker,
heartbeat-vs-channel turn sources, and elided payloads; the WS/decrypt
layers are tested against nostr-tools' own real NIP-44/NIP-42
implementations (round-tripped, never hand-rolled) with a fully in-memory
fake relay standing in for the network. v0.3 follows the same discipline —
`test/cost/`'s aggregation and SQLite-persistence fixtures include at least
one REAL kind-44200 event captured live from the local relay (see
`test/fixtures/live-capture-44200-turn-metrics.meta.md`), not just modeled
shapes; `docs/teardown2-claims-map.md` has the full source-verification
trail behind every non-obvious v0.3 claim.

## Non-goals / roadmap

- **No new Nostr event kinds.** buzz-fleet is a read-only client of what
  buzz already emits.
- **No reply/approve actions.** Read-only keeps this complementary to
  buzz's own approval-flow work, not competing with it.
- **No fleet-wide superuser reads**, ever — see [Auth model](#auth-model--read-this-before-wiring-in-a-key),
  [Auth model (v0.2)](#auth-model-v02--turn-telemetry), and
  [Auth model (v0.3)](#auth-model-v03--turn-cost-metrics--channel-messages).
- **Shipped in v0.2**: turn-level ingestion (kind `24200`, NIP-42-authed WS,
  NIP-44 owner-key decrypted) and the full six-state classifier — `wedged`,
  `crashed-mid-turn`, `deaf`, `swallowed` — layered on top of the alive/dead
  board v0.1 shipped. See [The six-state model](#the-six-state-model-v02).
- **Shipped in v0.3**: a fleet-wide cost/usage panel from kind `44200`
  (durable, SQLite-persisted, per-agent AND fleet-total trends — see
  [The cost panel](#the-cost-panel-v03--turn-metrics)), and a live kind-9
  channel-message feed that finishes `swallowed` detection end to end (see
  [Auth model (v0.3)](#auth-model-v03--turn-cost-metrics--channel-messages)
  for the corroboration window).
- **Not yet live-fed**: `deaf` still needs the channel *reaction* stream
  (👀 pickup/clear) as corroboration — the classifier fully supports it
  (fixture-tested, `channelActivity.recentMessages`) but nothing feeds it
  live yet. Unlike `swallowed`, `deaf` needs reactions, not just messages,
  which is a materially bigger integration (a second Nostr kind, plus
  matching each message to whether a reaction landed on it) — deferred
  rather than half-wired.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
