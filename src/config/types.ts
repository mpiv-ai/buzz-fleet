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
  /**
   * v0.2 turn telemetry (kind 24200) is NIP-44 owner-key-encrypted and
   * `#p`-gated per community — reading it needs one owner secret key per
   * relay. At most one of `ownerKeyFile`/`ownerKeyEnv` may be set; both are
   * optional, and a relay with neither just stays on the v0.1 presence-only
   * board. The key's actual VALUE is never accepted here, only a reference
   * to where the daemon (server-side, Node-only) should read it from at
   * runtime — see README > "Auth model" (v0.2).
   */
  /** Absolute or relative path to a file holding the owner's hex or nsec
   * secret key. Read server-side only, never by this config parser. */
  ownerKeyFile?: string;
  /** Name of an environment variable holding the owner's hex or nsec secret
   * key. The variable's VALUE is read server-side at runtime — this field
   * holds only its NAME. */
  ownerKeyEnv?: string;
  /**
   * The relay's real Nostr WebSocket origin, e.g. "ws://localhost:3000".
   * The v0.2 turns daemon runs server-side (Node), so — unlike `url` —
   * browser CORS never applies to it; it always dials a relay directly and
   * never needs a same-origin proxy workaround. Optional when `url` is
   * itself an absolute http(s) origin (the WS endpoint is derived by
   * swapping the scheme — see README > "Auth model" (v0.2) and
   * `resolveRelayWsUrl`); REQUIRED when `url` is a root-relative proxy path
   * (the v0.1 browser-CORS workaround — see README > "Browser CORS"),
   * since a relative path has no meaning outside a browser page's origin.
   */
  wsUrl?: string;
}

/** Parsed shape of `public/fleet.yaml`. */
export interface FleetConfig {
  relays: RelayConfig[];
  /** How often to re-poll each relay's bridge, in milliseconds. */
  pollIntervalMs: number;
  /** Display-only staleness threshold, in milliseconds. */
  deadAfterMs: number;
}
