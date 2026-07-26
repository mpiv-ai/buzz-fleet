import { resolve } from "node:path";
import { getPublicKey } from "nostr-tools";
import type { FleetConfig, RelayConfig } from "../config/types";
import { RingBuffer } from "../turns/ringBuffer";
import { resolveRelayWsUrl } from "../turns/relayUrl";
import { loadOwnerSecretKey as defaultLoadOwnerSecretKey } from "../turns/ownerKey";
import type { OwnerKeyRef } from "../turns/ownerKey";
import {
  connectTurnsStream as defaultConnectTurnsStream,
  type ConnectionStatus,
  type TurnsConnectionOptions,
} from "../turns/wsClient";
import {
  connectMetricsStream as defaultConnectMetricsStream,
  type MetricsConnectionOptions,
} from "../turns/metricsClient";
import {
  connectChannelMessagesStream as defaultConnectChannelMessagesStream,
  type ChannelMessagesConnectionOptions,
} from "../turns/channelMessagesClient";
import type { ChannelMessageRecord } from "../turns/swallowed";
import type { ObserverEvent } from "../turns/types";
import { openCostStore as defaultOpenCostStore } from "../cost/store";
import type { CostStore } from "../cost/store";
import { aggregateFleetTotal, aggregatePerAgent, aggregateTrend } from "../cost/aggregate";
import type { AgentCostSummary, CostTrendPoint, FleetCostSummary, TurnMetricRecord } from "../cost/types";

/**
 * Node-only orchestrator: the "daemon" the v0.2 contract requires, extended
 * in v0.3 to also ingest kind 44200 (turn cost metrics) and kind 9 (channel
 * messages, for swallowed corroboration). Reads each relay's
 * `ownerKeyFile`/`ownerKeyEnv` (never the parsed config's caller — see
 * `ownerKey.ts`), opens one connection of EACH kind per relay that has an
 * owner key configured, and buffers/persists decoded data per relay/agent.
 *
 * Deliberately does NOT classify — presence lives in the browser's existing
 * v0.1 poll (`useFleetPresence`), and `classifySlot`/`rollupAgentState` are
 * pure functions with no Node dependency, so the browser combines this
 * daemon's decoded-events snapshot with its own presence poll and classifies
 * there. That keeps classification in exactly one place, and keeps this
 * daemon's job to exactly what genuinely requires Node: reading key
 * material and holding live WS connections.
 *
 * Cost aggregation (`cost` on {@link TurnsSnapshot}) IS computed here
 * (Node-side, via the pure functions in `cost/aggregate.ts`), unlike turn
 * classification — the fleet-wide numbers a cost panel needs are cheap sums
 * over potentially many thousands of persisted rows, and shipping every raw
 * row to the browser on every poll would defeat the point of persisting
 * history at all. `channelMessages` (kind 9), by contrast, IS shipped raw
 * per relay — swallowed correlation needs each slot's own telemetry
 * cross-referenced against them, and that correlation is `buildBoard.ts`'s
 * job (browser-side, alongside classification), not this daemon's.
 */

export type ConnectTurnsStreamFn = typeof defaultConnectTurnsStream;
export type ConnectMetricsStreamFn = typeof defaultConnectMetricsStream;
export type ConnectChannelMessagesStreamFn = typeof defaultConnectChannelMessagesStream;
export type LoadOwnerSecretKeyFn = (ref: OwnerKeyRef) => Uint8Array;
export type OpenCostStoreFn = typeof defaultOpenCostStore;

export interface AgentEventsSnapshot {
  pubkey: string;
  label: string | undefined;
  /** This agent's ring-buffered decoded telemetry, chronological. */
  events: ObserverEvent[];
}

export type RelayTurnsStatus = ConnectionStatus | "error";

export interface RelayTurnsSnapshot {
  /** `relay.url` from fleet.yaml — the key to correlate with the browser's
   * presence-poll snapshot for the same relay. */
  configuredUrl: string;
  /** The WS origin actually dialed (post `resolveRelayWsUrl`). */
  wsUrl: string;
  status: RelayTurnsStatus;
  lastNotice: string | null;
  ownerPubkey: string | null;
  agents: AgentEventsSnapshot[];
  /** Recent kind-9 channel messages seen on this relay (any channel, any
   * author) — the raw corroboration feed `buildBoard.ts` filters per slot
   * via `swallowed.ts`. See module doc for why this is raw here but the
   * cost data below is pre-aggregated. */
  channelMessages: ChannelMessageRecord[];
}

export interface CostSnapshot {
  perAgent: AgentCostSummary[];
  fleetTotal: FleetCostSummary;
  trend: CostTrendPoint[];
}

export interface TurnsSnapshot {
  relays: RelayTurnsSnapshot[];
  cost: CostSnapshot;
}

const EMPTY_COST_SNAPSHOT: CostSnapshot = {
  perAgent: [],
  fleetTotal: { agentCount: 0, turnCount: 0, totalTokens: 0, totalCostUsd: 0 },
  trend: [],
};

/** Default daemon-side SQLite file — gitignored (see `.gitignore`), created
 * (including any missing parent directory) on first open by
 * `cost/store.ts`. */
export const DEFAULT_COST_STORE_PATH = resolve(process.cwd(), "data/buzz-fleet-cost.db");

/** Fleet-wide usage trend bucket width for `cost.trend`. One hour balances
 * a readable number of points against a reasonably long history window
 * without a caller-supplied range. */
export const DEFAULT_TREND_BUCKET_MS = 60 * 60 * 1000;

export interface TurnsDaemonDeps {
  loadOwnerSecretKey?: LoadOwnerSecretKeyFn;
  connectTurnsStream?: ConnectTurnsStreamFn;
  connectMetricsStream?: ConnectMetricsStreamFn;
  connectChannelMessagesStream?: ConnectChannelMessagesStreamFn;
  openCostStore?: OpenCostStoreFn;
  /** Default {@link DEFAULT_COST_STORE_PATH}; pass `":memory:"` for an
   * ephemeral store (tests). */
  costStorePath?: string;
  ringBufferCapacity?: number;
  channelMessagesBufferCapacity?: number;
  trendBucketMs?: number;
  now?: () => number;
}

export interface TurnsDaemon {
  start(): void;
  stop(): void;
  getSnapshot(): TurnsSnapshot;
}

interface RelayRuntime {
  configuredUrl: string;
  wsUrl: string;
  status: RelayTurnsStatus;
  lastNotice: string | null;
  ownerPubkey: string | null;
  labelByPubkey: Map<string, string | undefined>;
  buffersByPubkey: Map<string, RingBuffer<ObserverEvent>>;
  channelMessagesBuffer: RingBuffer<ChannelMessageRecord>;
  turnsConnection: { close(): void } | null;
  metricsConnection: { close(): void } | null;
  channelMessagesConnection: { close(): void } | null;
}

function relaysWithOwnerKey(config: FleetConfig): RelayConfig[] {
  return config.relays.filter((r) => r.ownerKeyFile !== undefined || r.ownerKeyEnv !== undefined);
}

export function createTurnsDaemon(config: FleetConfig, deps: TurnsDaemonDeps = {}): TurnsDaemon {
  const loadOwnerSecretKey = deps.loadOwnerSecretKey ?? defaultLoadOwnerSecretKey;
  const connectTurnsStream = deps.connectTurnsStream ?? defaultConnectTurnsStream;
  const connectMetricsStream = deps.connectMetricsStream ?? defaultConnectMetricsStream;
  const connectChannelMessagesStream =
    deps.connectChannelMessagesStream ?? defaultConnectChannelMessagesStream;
  const openCostStore = deps.openCostStore ?? defaultOpenCostStore;
  const costStorePath = deps.costStorePath ?? DEFAULT_COST_STORE_PATH;
  const ringBufferCapacity = deps.ringBufferCapacity;
  const channelMessagesBufferCapacity = deps.channelMessagesBufferCapacity;
  const trendBucketMs = deps.trendBucketMs ?? DEFAULT_TREND_BUCKET_MS;
  const now = deps.now ?? Date.now;

  const runtimes: RelayRuntime[] = [];
  let costStore: CostStore | null = null;
  let started = false;

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    costStore = openCostStore(costStorePath);
    const store = costStore;

    for (const relay of relaysWithOwnerKey(config)) {
      const runtime: RelayRuntime = {
        configuredUrl: relay.url,
        wsUrl: "",
        status: "connecting",
        lastNotice: null,
        ownerPubkey: null,
        labelByPubkey: new Map(relay.roster.map((a) => [a.pubkey, a.label])),
        buffersByPubkey: new Map(),
        channelMessagesBuffer: new RingBuffer<ChannelMessageRecord>(channelMessagesBufferCapacity),
        turnsConnection: null,
        metricsConnection: null,
        channelMessagesConnection: null,
      };
      runtimes.push(runtime);

      try {
        const secretKey = loadOwnerSecretKey({
          ownerKeyFile: relay.ownerKeyFile,
          ownerKeyEnv: relay.ownerKeyEnv,
        });
        const ownerPubkey = getPublicKey(secretKey);
        const wsUrl = resolveRelayWsUrl({ url: relay.url, wsUrl: relay.wsUrl });
        runtime.wsUrl = wsUrl;
        runtime.ownerPubkey = ownerPubkey;

        const trustedAgentPubkeys = new Set(relay.roster.map((a) => a.pubkey));

        const turnsOptions: TurnsConnectionOptions = {
          relayUrl: wsUrl,
          ownerSecretKey: secretKey,
          ownerPubkey,
          trustedAgentPubkeys,
          now,
          onFrame: ({ agentPubkey, event }) => {
            let buffer = runtime.buffersByPubkey.get(agentPubkey);
            if (!buffer) {
              buffer = new RingBuffer<ObserverEvent>(ringBufferCapacity);
              runtime.buffersByPubkey.set(agentPubkey, buffer);
            }
            buffer.push(event);
          },
          onStatusChange: (status) => {
            runtime.status = status;
          },
          onNotice: (message) => {
            runtime.lastNotice = message;
          },
          // EOSE means this subscription is established and live. Clearing the
          // notice here stops a transient error — typically the pre-AUTH
          // "auth-required: not authenticated" close, which the client then
          // recovers from by re-authing and resubscribing — from being
          // displayed forever against a healthy relay.
          onSubscribed: () => {
            runtime.lastNotice = null;
          },
        };
        runtime.turnsConnection = connectTurnsStream(turnsOptions);

        const metricsOptions: MetricsConnectionOptions = {
          relayUrl: wsUrl,
          ownerSecretKey: secretKey,
          ownerPubkey,
          trustedAgentPubkeys,
          now,
          onRecord: (record: TurnMetricRecord) => {
            store.insertTurnMetric(record);
          },
        };
        runtime.metricsConnection = connectMetricsStream(metricsOptions);

        const channelMessagesOptions: ChannelMessagesConnectionOptions = {
          relayUrl: wsUrl,
          ownerSecretKey: secretKey,
          ownerPubkey,
          now,
          onMessage: (message: ChannelMessageRecord) => {
            runtime.channelMessagesBuffer.push(message);
          },
        };
        runtime.channelMessagesConnection = connectChannelMessagesStream(channelMessagesOptions);
      } catch (error) {
        runtime.status = "error";
        runtime.lastNotice = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function stop(): void {
    for (const runtime of runtimes) {
      runtime.turnsConnection?.close();
      runtime.metricsConnection?.close();
      runtime.channelMessagesConnection?.close();
    }
    costStore?.close();
    costStore = null;
    started = false;
  }

  function buildCostSnapshot(): CostSnapshot {
    if (!costStore) {
      return EMPTY_COST_SNAPSHOT;
    }
    const records = costStore.listTurnMetrics();
    const labelByPubkey = new Map<string, string | undefined>();
    for (const runtime of runtimes) {
      for (const [pubkey, label] of runtime.labelByPubkey) {
        labelByPubkey.set(pubkey, label);
      }
    }
    return {
      perAgent: aggregatePerAgent(records, labelByPubkey),
      fleetTotal: aggregateFleetTotal(records),
      trend: aggregateTrend(records, trendBucketMs),
    };
  }

  function getSnapshot(): TurnsSnapshot {
    return {
      relays: runtimes.map((runtime) => ({
        configuredUrl: runtime.configuredUrl,
        wsUrl: runtime.wsUrl,
        status: runtime.status,
        lastNotice: runtime.lastNotice,
        ownerPubkey: runtime.ownerPubkey,
        agents: Array.from(runtime.buffersByPubkey.entries()).map(([pubkey, buffer]) => ({
          pubkey,
          label: runtime.labelByPubkey.get(pubkey),
          events: buffer.toArray(),
        })),
        channelMessages: runtime.channelMessagesBuffer.toArray(),
      })),
      cost: buildCostSnapshot(),
    };
  }

  return { start, stop, getSnapshot };
}
