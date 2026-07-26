import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { parseChannelMessageEvent } from "../../src/turns/channelMessages";

// Channel (kind 9) messages are plain Nostr chat events — unencrypted
// content, an "h" tag naming the channel. Shape confirmed against a real
// capture (fleet-captures-v02/20260726T045832Z_02_smoke_test_channel_messages.json)
// — see docs/teardown2-claims-map.md row (d).

function buildChannelEvent(opts: {
  secretKey: Uint8Array;
  channelId?: string;
  content?: string;
  createdAtSec?: number;
}) {
  return finalizeEvent(
    {
      kind: 9,
      created_at: opts.createdAtSec ?? 1_785_000_000,
      tags: opts.channelId === undefined ? [] : [["h", opts.channelId]],
      content: opts.content ?? "hello",
    },
    opts.secretKey,
  );
}

describe("parseChannelMessageEvent", () => {
  it("parses a well-formed kind-9 channel message", () => {
    const secretKey = generateSecretKey();
    const event = buildChannelEvent({
      secretKey,
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      createdAtSec: 1_785_041_167,
    });

    const result = parseChannelMessageEvent(event);

    expect(result).toEqual({
      pubkey: event.pubkey,
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      createdAt: 1_785_041_167_000,
    });
  });

  it("returns null when the event has no 'h' (channel) tag", () => {
    const event = buildChannelEvent({ secretKey: generateSecretKey() });

    expect(parseChannelMessageEvent(event)).toBeNull();
  });

  it("returns null for a non-kind-9 event", () => {
    const event = buildChannelEvent({
      secretKey: generateSecretKey(),
      channelId: "chan-1",
    });
    const wrongKind = { ...event, kind: 1 };

    expect(parseChannelMessageEvent(wrongKind)).toBeNull();
  });

  it("converts created_at from unix seconds to ms epoch", () => {
    const event = buildChannelEvent({
      secretKey: generateSecretKey(),
      channelId: "chan-1",
      createdAtSec: 1_000,
    });

    expect(parseChannelMessageEvent(event)?.createdAt).toBe(1_000_000);
  });
});
