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
import type { ObserverEvent } from "../turns/types";

/**
 * Node-only orchestrator: the "daemon" the v0.2 contract requires. Reads
 * each relay's `ownerKeyFile`/`ownerKeyEnv` (never the parsed config's
 * caller — see `ownerKey.ts`), opens one `connectTurnsStream` per relay that
 * has one configured, and buffers decoded telemetry per agent pubkey.
 *
 * Deliberately does NOT classify — presence lives in the browser's existing
 * v0.1 poll (`useFleetPresence`), and `classifySlot`/`rollupAgentState` are
 * pure functions with no Node dependency, so the browser combines this
 * daemon's decoded-events snapshot with its own presence poll and classifies
 * there. That keeps classification in exactly one place, and keeps this
 * daemon's job to exactly what genuinely requires Node: reading key
 * material and holding a live WS connection.
 */

export type ConnectTurnsStreamFn = typeof defaultConnectTurnsStream;
export type LoadOwnerSecretKeyFn = (ref: OwnerKeyRef) => Uint8Array;

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
}

export interface TurnsSnapshot {
  relays: RelayTurnsSnapshot[];
}

export interface TurnsDaemonDeps {
  loadOwnerSecretKey?: LoadOwnerSecretKeyFn;
  connectTurnsStream?: ConnectTurnsStreamFn;
  ringBufferCapacity?: number;
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
  connection: { close(): void } | null;
}

function relaysWithOwnerKey(config: FleetConfig): RelayConfig[] {
  return config.relays.filter((r) => r.ownerKeyFile !== undefined || r.ownerKeyEnv !== undefined);
}

export function createTurnsDaemon(config: FleetConfig, deps: TurnsDaemonDeps = {}): TurnsDaemon {
  const loadOwnerSecretKey = deps.loadOwnerSecretKey ?? defaultLoadOwnerSecretKey;
  const connectTurnsStream = deps.connectTurnsStream ?? defaultConnectTurnsStream;
  const ringBufferCapacity = deps.ringBufferCapacity;
  const now = deps.now ?? Date.now;

  const runtimes: RelayRuntime[] = [];
  let started = false;

  function start(): void {
    if (started) {
      return;
    }
    started = true;

    for (const relay of relaysWithOwnerKey(config)) {
      const runtime: RelayRuntime = {
        configuredUrl: relay.url,
        wsUrl: "",
        status: "connecting",
        lastNotice: null,
        ownerPubkey: null,
        labelByPubkey: new Map(relay.roster.map((a) => [a.pubkey, a.label])),
        buffersByPubkey: new Map(),
        connection: null,
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

        const options: TurnsConnectionOptions = {
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

        runtime.connection = connectTurnsStream(options);
      } catch (error) {
        runtime.status = "error";
        runtime.lastNotice = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function stop(): void {
    for (const runtime of runtimes) {
      runtime.connection?.close();
    }
    started = false;
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
      })),
    };
  }

  return { start, stop, getSnapshot };
}
