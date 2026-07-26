# Fixture provenance: `live-capture-44200-turn-metrics.json`

Three REAL kind-44200 (NIP-AM) events, captured live from the local demo
rig's relay, decrypted and decoded through the real application code path —
not modeled, not synthetic.

- **Captured**: 2026-07-26T06:28Z (approx; exact query below)
- **Relay**: `buzz-prod-relay-1` (`ghcr.io/block/buzz:sha-25e7864`, docker
  compose, `~/dev/buzz-local`), `Up 3 hours (healthy)` at capture time,
  `http://localhost:3000`.
- **Subject**: `gatekeeper` (`f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1`),
  durable history from three earlier smoke-test/demo turns — the bridge
  (`buzz-acp`) was NOT running at capture time; kind 44200 is durable
  (unlike kind 24200), so this needed no live publisher, only the relay's
  own storage.
- **Path (real application code, not an ad hoc script)**:
  1. `public/fleet.yaml`'s relay entry temporarily set
     `ownerKeyFile: ~/dev/buzz-local/owner.key` (reverted before commit —
     `git diff` shows no trace; same pattern the v0.2 rig-demo sessions
     used, see `fleet-captures-v02/20260726T053300Z_30_timeline.md`).
  2. `npm run dev` (nohup, backgrounded), which starts
     `src/server/turnsMiddleware.ts`'s daemon on first request.
  3. `curl -s http://localhost:5173/turns-state.json` — the DAEMON did the
     real NIP-42 auth, real NIP-44 decrypt (`metricsClient.ts` /
     `metricsDecrypt.ts`), and real SQLite persist (`cost/store.ts`) end to
     end. `cost.fleetTotal.turnCount` read `3`, confirming three real,
     durable 44200 events were found and decoded — not zero, which is what
     a wiring bug or an empty relay would have shown instead.
  4. The three rows were then read directly out of the daemon's own SQLite
     file (`data/buzz-fleet-cost.db`, gitignored) via `node:sqlite` —
     no key material touched in this step; the rows were already
     decrypted+redacted by step 3's real decrypt boundary
     (`metricsDecrypt.ts`'s `redactSecrets` call) before ever reaching
     disk.
  5. Reshaped from the store's snake_case SQL columns into the
     camelCase `TurnMetricRecord` JSON shape (`src/cost/types.ts`) for this
     fixture — a 1:1 field rename, no values altered.
  6. Dev server stopped; `public/fleet.yaml`'s `ownerKeyFile` edit reverted
     (`git diff public/fleet.yaml` — clean) before this fixture was
     committed.

## What the real data actually shows (useful signal, not just proof-of-life)

- `harness: "buzz-agent"`, `model: "qwen3:8b"` — the demo rig's real
  harness/model, not NIP-AM's `"goose"` doc example. Confirms the parser
  handles arbitrary harness strings, not just the spec's own example value.
- Every record's `turn.*` is all-null and `deltaReliable: false` — this
  harness build reports `cumulative` counters only, never a per-turn delta.
  `cumulative.totalTokens`/`costUsd` are ALSO null (only
  `inputTokens`/`outputTokens` are populated) — real evidence that
  `ZERO_TOKEN_COUNTS`-style partial-null handling (`metricsDecrypt.ts`'s
  `parseTokenCounts`, `aggregate.ts`'s `sumNonNull`) is exercised by real
  wire data, not just synthetic fixtures.
- `stopReason: "end_turn"` on all three — a recognized value, so this
  fixture doesn't exercise the unknown-fold path (that's covered by
  synthetic fixtures in `test/turns/metricsDecrypt.test.ts`, per NIP-AM's
  own "MUST treat unrecognized values as unknown" requirement, which real
  rig data can't be relied on to ever demonstrate on demand).
- `turnId`s (`e2e74aa7-…`, `e1dc72d6-…`, `ae8b5f8e-…`) and `channelId`
  (`5cdc97df-…`, `#release-gate`) match the same real turns documented in
  `~/dev/buzz-local/fleet-captures-v02/` — this is the SAME rig session's
  data, cross-referenced, not a one-off unverifiable capture.

## What's NOT in this fixture, and why

The raw wire event (`id`/`pubkey`/`created_at`/`tags`/`content`) is not
included — `content` is real NIP-44 v2 ciphertext, undecryptable by any
test that doesn't hold the real owner secret key (which is never committed,
by design — see `ownerKey.ts`). A fixture consumer needs the DECODED,
already-redacted record to assert against; the raw ciphertext would be
inert bytes no test could do anything with. The event ids captured above
(`eventId`) are the wire event's real `id` field, so the link back to a
real, verifiable relay event is preserved without embedding anything
secret-adjacent.

Used by `test/cost/aggregate.test.ts` / `test/cost/store.test.ts` (see the
"real capture" describe blocks) to prove aggregation and persistence handle
genuinely-observed wire shapes — partial nulls, a non-spec-example harness
string — not just hand-modeled fixtures.
