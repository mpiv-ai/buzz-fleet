# Teardown #2 claims-to-sources map

One row per claim the second buzz-internals teardown article will make.
Every claim is pinned to a source file:line at a named commit, with a
verification date. The article itself is written by the orchestrator, not
this repo — this document is the evidence it's built from.

## Verification context (read this before the individual claims)

Three commit references recur throughout this document:

| Ref | Repo | Commit | Date |
|---|---|---|---|
| **Code-contract pin** | `block/buzz` | `384c72dee6336234beae3c1a0fec305044815245` (`384c72d`) | 2026-07-25T02:30:33Z |
| **Local relay build** | `block/buzz` | `25e7864b35f4dfd1c0ff31304a38555230a85f8d` (`sha-25e7864`) | 2026-07-25T23:49:56Z |
| **buzz/buzz block/buzz HEAD at verification time** | `block/buzz` | `c2a4ee711e481bb427d6cf8cd08b2c7329d1508c` | 2026-07-26T02:51:09Z |

**Drift correction, verified, not assumed:** the ticket that scoped this work
described the local relay build as "an older build" than the code-contract
pin. Checked directly (`gh api repos/block/buzz/compare/384c72d...25e7864`
and `.../25e7864...main`): `25e7864` is **17 commits ahead** of `384c72d` and
**7 commits behind** current `main`. The local relay build is chronologically
**newer** than the pinned contract commit, not older. Every claim below says
explicitly which of the three it was verified against, per row.

Unless a row says otherwise, source citations are against **`384c72d`**
(the ticket's own pin), fetched read-only via `gh api` /
`raw.githubusercontent.com` — never cloned, never written to.

`buzz-fleet` (this repo) citations are against commit range `a804d4f`
(pre-v0.3 base, pushed) through **`2336ad7`** (latest v0.3 push as of this
document), `mpiv-ai/buzz-fleet`, `main`.

Verification date for every row below: **2026-07-26**.

---

## (a) NIP-AO documents 4 frame kinds; shipping buzz-acp emits 13

**Claim**: `docs/nips/NIP-AO.md`'s normative "Frame Kinds" table lists four
values. The actual shipping `buzz-acp` binary emits at least thirteen
distinct `kind` strings on the wire. `buzz-fleet`'s classifier treats `kind`
as an open string set specifically because of this gap — unknown kinds are
default pass-through, never a parse failure.

**NIP doc** (`block/buzz@384c72d`): [`docs/nips/NIP-AO.md`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/docs/nips/NIP-AO.md),
"Frame Kinds" section — table lists exactly four: `acp_read`, `acp_write`,
`turn_started`, `session_resolved`.

**Emitter sources** (`block/buzz@384c72d`, all confirmed as real `.emit()`/
`.observe()` call sites, not test code — each checked against the file's
own `mod tests {}` boundary):

| `kind` | File:line |
|---|---|
| `acp_read` | `crates/buzz-acp/src/acp.rs:1120`, `:1414` |
| `acp_write` | `crates/buzz-acp/src/acp.rs:963` |
| `turn_started` | `crates/buzz-acp/src/pool.rs:1295` |
| `turn_liveness` | `crates/buzz-acp/src/pool.rs:3194` |
| `turn_completed` | `crates/buzz-acp/src/pool.rs:3295` (in `TurnCompletionGuard::drop`) |
| `turn_error` | `crates/buzz-acp/src/lib.rs:3221` |
| `agent_panic` | `crates/buzz-acp/src/lib.rs:3450` |
| `harness_started` | `crates/buzz-acp/src/lib.rs:1304` |
| `agent_initialized` | `crates/buzz-acp/src/lib.rs:3788` |
| `managed_agent_runtime_lifecycle` | `crates/buzz-acp/src/lib.rs:103` |
| `control_result` | `crates/buzz-acp/src/lib.rs:913` |
| `session_resolved` | `crates/buzz-acp/src/pool.rs:1573` |
| `session_config_captured` | `crates/buzz-acp/src/pool.rs:908` |

That's 13, not 12 — see the correction below.

**buzz-fleet's list** (`buzz-fleet@a804d4f`, unchanged by v0.3):
[`src/turns/types.ts:43-58`](../src/turns/types.ts), `KNOWN_FRAME_KINDS`.

**Correction to buzz-fleet's own v0.2 code comment** (found while verifying
this row, not itself a v0.3 change — flagged, not silently fixed):
`types.ts:52-56`'s comment on `session_config_captured` says it was
"Observed live on the demo rig 2026-07-26, in neither the NIP's list of
four nor the v0.2 contract's list of twelve." The rig observation is real
(`~/dev/buzz-local/acp.v02-demo.log` and the fleet-captures-v02 session),
but `session_config_captured` is ALSO already present in `buzz-acp` source
at `384c72d` (`pool.rs:908`, dated 2026-07-25 — before the 2026-07-26 rig
session that "discovered" it). It was not a rig-only anomaly; the v0.2
KNOWN_FRAME_KINDS list of 12 was simply incomplete against the source that
already existed. Net effect on the claim is the same direction, stronger if
anything: the NIP documents 4, source (independently of any live rig) emits
13.

---

## (b) Frames drop silently under the harness's own rate-limit pacing

**Claim**: `buzz-acp` self-paces its observer-frame publisher at 6 frames/sec
with a 90-frames-per-rolling-60s cap. A gap in the wire stream caused by this
pacing produces no error anywhere — `buzz-fleet`'s classifier therefore
treats a bare tick gap as never sufficient, alone, to flip a slot's state.

**Harness pacing source** (`block/buzz@384c72d`):
[`crates/buzz-acp/src/lib.rs:364-365`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/crates/buzz-acp/src/lib.rs#L364-L365):
```rust
const OBSERVER_PUBLISH_INTERVAL: Duration = Duration::from_millis(167);
const OBSERVER_PUBLISH_LIMIT_PER_MINUTE: usize = 90;
```
(167ms ≈ 1000/6, i.e. 6/s; the `ObserverPublishPacer` struct implementing
the dual-window gate follows immediately, `lib.rs:366-406`.)

**Review thread**: [block/buzz#2217](https://github.com/block/buzz/pull/2217)
— "fix(acp): pace relay observer frames (6/s + 90/min, zero burst)". Actually
a **PR**, not an issue; merged 2026-07-21 (`merge_commit_sha`
`9a788c7aeea67ef1d3a222cbd288e5494e714016`), well before the `384c72d` pin,
so the pacer is genuinely present at the pinned commit (confirmed above, not
assumed from the PR description alone). The PR body documents the exact
motivating failure — a 24-worker harness startup burst exceeding the
*relay's* separate WS admission budget (`50 events / 5s`, unrelated flat
number) — and a live-rig validation table showing 27→0 rate-limit rejections
after the pacer landed.

**Distinct relay-side limit** (do not conflate with the above — two
different gates): `crates/buzz-relay/src/handlers/event.rs:889-911`
(`observer_frame_rate_limited`, 100/sec per agent) and `:1040`'s
`"rate-limited: observer frame rate exceeded (100/sec per agent)"` NOTICE
text — this is what `buzz-fleet`'s `isRateLimitNotice()` matches against
(`src/turns/wsClient.ts`), a connection-health signal, not itself telemetry.

**buzz-fleet's guardrail tests** (`buzz-fleet@a804d4f`, unchanged by v0.3):
[`test/turns/classify.test.ts:235`](../test/turns/classify.test.ts), describe
block `"classifySlot — the silent-drop guardrail (hard rule, dedicated
tests)"`, containing:
- `"does NOT flip an alive, freshly-opened turn to crashed-mid-turn on a bare tick gap with presence still alive"` (line 236)
- `"does NOT flip an already-wedged turn to crashed-mid-turn on a bare tick gap with presence still alive"` (line 253)
- `"does NOT flip to dead on a presence-poll-shaped gap alone when telemetry keeps ticking (presence lagging, not absent)"` (line 279)

---

## (c) Three distinct "looks online but isn't really working" failure classes

**Claim**: at least three genuinely different failure modes present the same
surface symptom (agent process alive, nothing useful happening), and each
needs different corroborating evidence to detect — conflating them into one
"unhealthy" bucket would hide the actual fix each one needs.

| Class | Issue | Title | State (2026-07-26) | buzz-fleet state | Test names |
|---|---|---|---|---|---|
| Never picks up mentions (relay/community mismatch) | [block/buzz#2444](https://github.com/block/buzz/issues/2444) | "[Bug] Desktop 0.4.23 spawns managed agents on ws://127.0.0.1:3000 while the community uses ws://localhost:3000 - agents silently stop responding" | open | `deaf` | `test/turns/classify.test.ts:458` describe `"classifySlot — deaf"`: `"flags deaf when the channel is active with zero channel-sourced turn_starts and an unreacted message"` (459), `"does not flag deaf when a channel-sourced turn_started exists in the window"` (line ~), `"does not flag deaf when every recent message already has a reaction"` |
| Runtime dies with no signal | [block/buzz#2453](https://github.com/block/buzz/issues/2453) | "An agent's runtime can die silently — no signal in the channel, no way to restart it" | open | `dead` (process-wide) / slot-local `dead` via circuit-breaker cooldown | `test/turns/classify.test.ts:137` describe `"classifySlot — dead"`: `"is dead when presence is absent and there is no open turn"`, `"is dead when presence is absent even if the last turn resolved cleanly"`; slot-local variant at `:405` describe `"classifySlot — circuit breaker is per-slot"`: `"reads the tripped slot as dead once it has been silent past the 300s cooldown"` (line 427) |
| Reply silently dropped after apparent success | [block/buzz#2698](https://github.com/block/buzz/issues/2698), [#2459](https://github.com/block/buzz/issues/2459) | "[Bug] buzz-acp reply delivery is implicit — Sonnet-class agents answer in session text and every reply is silently dropped" / "buzz-acp: turn completes ok but reply is silently lost when the agent's buzz CLI write fails" | both open | `swallowed` | `test/turns/classify.test.ts:514` describe `"classifySlot — swallowed"`: `"flags swallowed when a channel-sourced turn completed ok with no reply seen after"` (515), `"does not flag swallowed when the reply was seen"`, `"does not flag swallowed for a heartbeat-sourced turn (nothing to reply to)"`; v0.3 live-wiring tests: `test/turns/swallowed.test.ts:59-` (`computeReplySeenAfterLastChannelTurn` suite) and `test/turns/buildBoard.test.ts:201` describe `"swallowed detection (v0.3)"` |

`#2444`'s body (verified, not just its title): the actual bug is a
community-boundary mismatch (`ws://127.0.0.1:3000` vs `ws://localhost:3000`
are different communities server-side), producing exactly the `deaf`
symptom — "agents never see any message and never reply... no error
anywhere." Confirms the title's framing is accurate, not just a plausible-
sounding label.

---

## (d) Live rig captures — what each file shows

All paths relative to `~/dev/buzz-local/` (not a git repo tracked by
`buzz-fleet`, per the project's local-only rig convention). Verified by
direct read, 2026-07-26.

**`fleet-captures-v01/`** (MPI-463 AC5 — v0.1 presence alive/dead/recovered):
- `20260725220419_timeline.md` — run 1: alive capture + kill, but blocked on
  restart (a red herring `BUZZ_PRIVATE_KEY` arg-name assumption; genuinely
  stopped short of reading `agent.key`, no recovery frame this run).
- `20260725215729_01_alive.png`, `20260725215940_02_dead.png` — run 1's two
  screenshots (superseded by run 2's cleaner sequence below).
- `20260725222300_timeline_run2_complete.md` — run 2: the complete
  alive→dead→recovered sequence, captured TWICE — once via SIGTERM
  (graceful; presence clears itself, board shows dead 40s later) and once
  via SIGKILL (no graceful clear; relay drops the socket-closed key
  immediately, 0s elapsed — proving the 90s Redis TTL is a ceiling for the
  half-open-socket case, block/buzz#2412, not the mechanism for a normal
  kill).
- `20260725221741_01_alive_gatekeeper_online.png` → `20260725222136_05_recovered_after_sigkill_restart.png`
  — the five numbered screenshots run 2's timeline narrates in order.

**`fleet-captures-v02/`** (MPI-464 — v0.2 turn telemetry, wedged/recovered):
- `20260726T045832Z_01_timeline.md` — first attempt, BLOCKED: three real
  smoke-test turns completed (confirmed via `buzz messages get`) but zero
  kind-24200 frames reached the daemon. Root-caused via a read-only
  Postgres `SELECT`: `gatekeeper`'s `users.agent_owner_pubkey` was `NULL`,
  so `buzz-db/src/user.rs::is_agent_owner` matched no row and every publish
  was silently rejected (`buzz-acp`'s publisher is fire-and-forget, so
  nothing in its own log showed this).
- `20260726T045832Z_02_smoke_test_channel_messages.json` — the real kind-9
  channel messages from that session; used directly as the shape reference
  for `src/turns/channelMessages.ts`'s parser and (two of its timestamps)
  the corroboration-window rationale in `src/turns/swallowed.ts`.
- `20260726T045832Z_03_db_verification_readonly_select.txt` — the actual
  `SELECT` output proving the NULL (one row, `agent_owner_pubkey` column
  blank).
- `20260726T053144Z_10_wedged_turns_state.json` / `_11_wedged_board_rendered.html` / `_12_wedged_gate_log.jsonl`
  — full daemon snapshot, rendered board DOM, and gate log at the moment
  the board correctly read `wedged` for both the agent row and Slot 0.
- `20260726T053259Z_20_recovered_turns_state.json` / `_21_recovered_board_rendered.html` / `_22_recovered_gate_log.jsonl`
  — the same three, moments after the owner's 👍 resolved the turn: both
  rows `alive`, open turn cleared.
- `20260726T053300Z_30_timeline.md` — the successful run's full narrative:
  the NIP-OA minting fix that cleared the blocker (no DB write — a
  cryptographically-attested first-write-wins column set by the relay
  itself), a second blocker (`MCP_HOOK_SERVERS='*'` opt-in, undocumented in
  the ticket's own recipe), and the wedged→recovered timeline table.

---

## (e) Redaction at the decrypt boundary

**Claim**: decrypted observer payloads can carry configuration blocks, and
configuration is where credentials live, so a consumer that stores or renders
raw payloads can end up holding key material it never meant to handle.
`buzz-fleet` redacts at the decrypt boundary for that reason.

This row previously carried a specific upstream finding with reproduction
detail. That has been removed pending a private report to the maintainers via
the channel `block/buzz`'s SECURITY.md specifies, and it will be restored or
rewritten once they have responded. The defensive behavior below stands on its
own and is not contingent on that report.

**buzz-fleet's redaction** (`buzz-fleet@a804d4f`, unchanged by v0.3 — the
boundary covers kind 44200 too, since `metricsDecrypt.ts` reuses the same
`redactSecrets` call):
- [`src/turns/redact.ts`](../src/turns/redact.ts) — field-name pattern, the
  `{name,value}` env-pair shape, and bare `nsec1…` format anywhere in the tree.
  Deliberately not "looks like hex", since pubkeys, event ids and turn ids are
  hex and are public.
- [`src/turns/decrypt.ts:103`](../src/turns/decrypt.ts) — the call site, applied
  to every decoded event before it reaches the ring buffer, `/turns-state.json`,
  the UI, or a capture.
- [`src/turns/metricsDecrypt.ts`](../src/turns/metricsDecrypt.ts) — the kind
  44200 equivalent, defense in depth rather than a response to an observed leak.

---

## (f) NIP-OA owner-attestation provisioning path

**Claim**: an agent's `agent_owner_pubkey` — the column every kind-24200/
44200 publish is authorized against — is set exclusively by the relay
itself, from a cryptographically self-proving credential carried in the
signed NIP-42 AUTH event, first-write-wins. No `buzz`/`buzz-admin` CLI
subcommand sets it directly.

**Path** (`block/buzz@384c72d`):
1. `buzz-acp` forwards `BUZZ_AUTH_TAG` into the signed NIP-42 AUTH event:
   [`crates/buzz-acp/src/lib.rs:1337-1344`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/crates/buzz-acp/src/lib.rs#L1337-L1344).
2. The relay extracts and verifies it on the open-relay path:
   [`crates/buzz-relay/src/handlers/auth.rs:258`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/crates/buzz-relay/src/handlers/auth.rs#L258),
   calling `crate::api::relay_members::materialize_nip_oa_owner(...)`
   (gated on `!state.config.require_relay_membership && auth_tag_json.is_some()`,
   `auth.rs:245-258` — i.e. only on an OPEN relay, matching this rig's
   `BUZZ_REQUIRE_RELAY_MEMBERSHIP=false`).
3. `materialize_nip_oa_owner`:
   [`crates/buzz-relay/src/api/mod.rs:174-206`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/crates/buzz-relay/src/api/mod.rs#L174-L206)
   — ensures both agent and owner rows exist, then calls `set_agent_owner`.
4. `set_agent_owner`:
   [`crates/buzz-db/src/user.rs:291-320`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/crates/buzz-db/src/user.rs#L291-L320)
   — `UPDATE users SET agent_owner_pubkey = $1 WHERE ... AND agent_owner_pubkey IS NULL`,
   the doc comment states the property directly: *"Conditional UPDATE: only
   set owner if currently NULL. This makes 'first mint wins' atomic — no
   TOCTOU race between concurrent mints."*
5. The read side every publish is checked against — `is_agent_owner`,
   `crates/buzz-db/src/user.rs:354-368` — the exact query the fleet-captures
   timeline already reverse-engineered from behavior (`agent_owner_pubkey IS
   NOT NULL` in the `WHERE`, so a NULL row matches nothing, `.unwrap_or(false)`
   on the caller side).

**Test vector NIP-OA doc** (`block/buzz@384c72d`):
[`docs/nips/NIP-OA.md`, "Test Vectors" section, lines 111-125](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/docs/nips/NIP-OA.md#L111-L125) —
`sha256(preimage)=08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6`,
confirmed byte-for-byte against what `buzz-local/mint-owner-attestation.sh`
and `buzz-fleet/scripts/mint-nip-oa-tag.mjs` reproduce and verify before
touching any real key.

**buzz-fleet's minter** (`buzz-fleet@a804d4f`, unchanged by v0.3):
[`scripts/mint-nip-oa-tag.mjs`](../scripts/mint-nip-oa-tag.mjs), wrapper
`~/dev/buzz-local/mint-owner-attestation.sh` — signs with `@noble/curves`
BIP-340 schnorr (nostr-tools' own dependency), `OWNER_PRIV` read from the
environment only, never argv, never printed, never written to disk.

**Live confirmation**: `fleet-captures-v02/20260726T053300Z_30_timeline.md` —
read-only `SELECT` before/after shows `agent_owner_pubkey` flipping from
NULL to the real owner pubkey purely from minting+relaunching, no `UPDATE`
ever issued by this project.

---

## (g) 44200 cost-panel facts

**Claim**: kind 44200 (NIP-AM) is a durable per-turn usage record, distinct
from kind 24200's ephemeral telemetry; `stopReason` folds any unrecognized
value to `"unknown"` without failing parsing; and Block's own desktop app
already ships a per-agent, (harness, model)-grouped usage breakdown, which
is why `buzz-fleet`'s v0.3 cost panel leads with fleet-wide/cross-agent
trends instead of cloning that view.

**NIP doc** (`block/buzz@384c72d`):
[`docs/nips/NIP-AM.md`](https://github.com/block/buzz/blob/384c72dee6336234beae3c1a0fec305044815245/docs/nips/NIP-AM.md) —
full text fetched and read in full for this ticket. Key normative points
used directly in `buzz-fleet`'s implementation:
- "kind 44200 is a regular event by Buzz convention... stored, append-only,
  never replaced" (vs. NIP-AO's ephemeral 24200) — `src/cost/types.ts`'s
  module doc, `src/turns/metricsClient.ts`'s module doc.
- Tag layout: exactly one `p` (owner), exactly one `agent`, **no `frame`
  tag** — the one structural difference from 24200 that made reusing
  `wsClient.ts`'s frame-gated `handleWireEvent` directly (rather than
  writing a parallel one) actively wrong, not just redundant. Verified by a
  dedicated test:
  `test/turns/metricsClient.test.ts` — event builder comment "Deliberately
  NO 'frame' tag" plus the "decodes a valid metric event with NO frame tag
  and calls onRecord" test.
- `stopReason` MUST be one of `end_turn`, `max_tokens`, `cancelled`,
  `error`, `unknown`; "Consumers MUST treat unrecognized stopReason values
  as unknown; the token counts remain valid." → `src/cost/types.ts:34-38`,
  `foldStopReason()`, tested for every named value plus two synthetic
  unrecognized ones in `test/cost/types.test.ts` and
  `test/turns/metricsDecrypt.test.ts`.
- "a null MUST NOT be recorded or summed as zero" → `src/cost/aggregate.ts`'s
  `sumNonNull()`, tested in `test/cost/aggregate.test.ts`.

**Differentiation reference — Block's desktop per-agent breakdown**:
[block/buzz#2790](https://github.com/block/buzz/pull/2790), "feat(desktop):
add harness to NIP-AM agent-usage breakdown" — merged 2026-07-25
(`merged_at` 2026-07-25T16:04:12Z), but merged into the **`duncan/agent-usage-archive`
feature branch**, not `main` (`base.ref` = `duncan/agent-usage-archive`).
Checked directly (`gh api repos/block/buzz/compare/main...duncan/agent-usage-archive`):
`status: "diverged"`, 9 ahead / 10 behind `main` as of the verification
date — this feature is real and shipped-on-a-branch, not yet part of
`main`, and therefore not part of the `384c72d` pin either. Precisely: the
PR groups `AgentScope.models` by `(harness, model)` instead of `model`
alone, and renders `harness` as a sub-label per model row in
`AgentUsageFocusedView` — a genuinely per-agent, drill-down-shaped view.

**buzz-fleet's response to that constraint** (`buzz-fleet@2336ad7`):
[`src/ui/CostPanel.tsx`](../src/ui/CostPanel.tsx) — structural, not
cosmetic: the fleet-total summary and fleet-wide trend table render
unconditionally as the section's primary content; the per-agent breakdown
is a real `<details>` disclosure widget, closed by default, module doc
citing this exact PR. Verified by
`test/ui/CostPanel.test.tsx`'s `"puts the fleet trend before the per-agent
drill-down in document order (fleet-level is the point)"` test (DOM-order
assertion via `compareDocumentPosition`, not just a visual claim).

**44200 cost-panel implementation** (`buzz-fleet@2336ad7`, all TDD, all
cited elsewhere in this document by file but summarized here for this row):
`src/cost/types.ts`, `src/turns/metricsDecrypt.ts`, `src/turns/metricsClient.ts`,
`src/cost/aggregate.ts`, `src/cost/store.ts` (`node:sqlite`, chosen over
`better-sqlite3` after empirically confirming `DatabaseSync`/`StatementSync`
present and usable — unflagged, `ExperimentalWarning` only — on the
installed Node v22.22.3; `package.json`'s `engines.node` is `>=22.12.0`, the
version `node:sqlite` first shipped unflagged), `src/server/turnsDaemon.ts`
(wiring + fleet-wide aggregation), `src/ui/CostPanel.tsx`. At least one REAL
kind-44200 capture (not just modeled fixtures) is
`test/fixtures/live-capture-44200-turn-metrics.json` — see its companion
`.meta.md` for full provenance (queried live through the real daemon code
path, `cost.fleetTotal.turnCount` read `3` before the raw rows were pulled
from the daemon's own already-decrypted SQLite file).
