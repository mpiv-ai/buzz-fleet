/** One agent to watch on a relay. */
export interface RosterAgent {
  /** 64-character lowercase hex Nostr pubkey. */
  pubkey: string;
  /** Optional display label (e.g. "gatekeeper"). Falls back to the pubkey. */
  label?: string;
}

/** One relay's HTTP bridge, plus the roster of agents to watch on it. */
export interface RelayConfig {
  /** HTTP(S) origin of the relay's bridge, e.g. "http://localhost:3000". */
  url: string;
  /**
   * Self-declared, unsigned caller identity for the bridge's dev-mode
   * `X-Pubkey` auth. Not a credential — see README > "Auth model".
   */
  callerPubkey: string;
  roster: RosterAgent[];
}

/** Parsed shape of `public/fleet.yaml`. */
export interface FleetConfig {
  relays: RelayConfig[];
  /** How often to re-poll each relay's bridge, in milliseconds. */
  pollIntervalMs: number;
  /** Display-only staleness threshold, in milliseconds. */
  deadAfterMs: number;
}
