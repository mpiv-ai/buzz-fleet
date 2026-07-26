/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { createTurnsMiddleware } from "../../src/server/turnsMiddleware";
import type { TurnsDaemon } from "../../src/server/turnsDaemon";

const GATEKEEPER_PK = "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";

const VALID_YAML = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
        label: gatekeeper
`;

function fakeDaemon(snapshot: object): TurnsDaemon {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue(snapshot),
  };
}

describe("createTurnsMiddleware", () => {
  it("parses the injected fleet.yaml text and starts the daemon lazily on first handle()", () => {
    const daemon = fakeDaemon({ relays: [] });
    const createDaemon = vi.fn().mockReturnValue(daemon);
    const middleware = createTurnsMiddleware({
      readFleetYaml: () => VALID_YAML,
      createDaemon,
    });

    expect(createDaemon).not.toHaveBeenCalled();

    const body = middleware.handle();

    expect(createDaemon).toHaveBeenCalledTimes(1);
    expect(daemon.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(body)).toEqual({ relays: [] });
  });

  it("reuses the same daemon instance across repeated handle() calls", () => {
    const daemon = fakeDaemon({ relays: [] });
    const createDaemon = vi.fn().mockReturnValue(daemon);
    const middleware = createTurnsMiddleware({ readFleetYaml: () => VALID_YAML, createDaemon });

    middleware.handle();
    middleware.handle();

    expect(createDaemon).toHaveBeenCalledTimes(1);
    expect(daemon.start).toHaveBeenCalledTimes(1);
  });

  it("passes the parsed FleetConfig through to createDaemon", () => {
    const daemon = fakeDaemon({ relays: [] });
    const createDaemon = vi.fn().mockReturnValue(daemon);
    const middleware = createTurnsMiddleware({ readFleetYaml: () => VALID_YAML, createDaemon });

    middleware.handle();

    const config = createDaemon.mock.calls[0]?.[0];
    expect(config?.relays[0]?.roster[0]?.label).toBe("gatekeeper");
  });

  it("dispose() stops the daemon", () => {
    const daemon = fakeDaemon({ relays: [] });
    const createDaemon = vi.fn().mockReturnValue(daemon);
    const middleware = createTurnsMiddleware({ readFleetYaml: () => VALID_YAML, createDaemon });

    middleware.handle();
    middleware.dispose();

    expect(daemon.stop).toHaveBeenCalledTimes(1);
  });

  it("dispose() before any handle() call is a no-op, not a crash", () => {
    const createDaemon = vi.fn();
    const middleware = createTurnsMiddleware({ readFleetYaml: () => VALID_YAML, createDaemon });

    expect(() => middleware.dispose()).not.toThrow();
    expect(createDaemon).not.toHaveBeenCalled();
  });

  it("surfaces a malformed fleet.yaml as a thrown error rather than a silent empty board", () => {
    const middleware = createTurnsMiddleware({
      readFleetYaml: () => "relays: []\n",
      createDaemon: vi.fn(),
    });

    expect(() => middleware.handle()).toThrow(/relays/i);
  });

  it("exposes the expected middleware path", () => {
    const middleware = createTurnsMiddleware({
      readFleetYaml: () => VALID_YAML,
      createDaemon: vi.fn().mockReturnValue(fakeDaemon({ relays: [] })),
    });

    expect(middleware.path).toBe("/turns-state.json");
  });
});
