/**
 * Resolve the real WS origin a v0.2 daemon should dial for a relay's kind
 * 24200 stream. The daemon runs server-side (Node), so — unlike the
 * browser's HTTP presence poll — it never needs `url`'s CORS-proxy
 * workaround (see README > "Browser CORS"); it always wants the relay's
 * real origin.
 */
export function resolveRelayWsUrl(relay: { url: string; wsUrl?: string }): string {
  if (relay.wsUrl) {
    return relay.wsUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(relay.url);
  } catch {
    throw new Error(
      `resolveRelayWsUrl: "${relay.url}" is not an absolute URL and no wsUrl was given — ` +
        `a root-relative url only has meaning inside a browser page's own origin (the v0.1 ` +
        `CORS-proxy workaround), which the server-side daemon has no equivalent of. Set ` +
        `relays[].wsUrl to this relay's real ws(s):// origin.`,
    );
  }

  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    return relay.url;
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
    return parsed.toString().replace(/\/$/, "");
  }
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
    return parsed.toString().replace(/\/$/, "");
  }

  throw new Error(`resolveRelayWsUrl: unsupported url scheme in "${relay.url}"`);
}
