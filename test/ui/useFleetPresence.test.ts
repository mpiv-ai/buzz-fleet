import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useFleetPresence } from "../../src/ui/useFleetPresence";
import type { FleetConfig } from "../../src/config/types";
import type { AgentPresence } from "../../src/presence/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const loadConfigMock = vi.fn();
const pollFleetMock = vi.fn();

vi.mock("../../src/config/loadConfig", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));
vi.mock("../../src/ui/pollFleet", () => ({
  pollFleet: (...args: unknown[]) => pollFleetMock(...args),
}));

const GATEKEEPER = "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";

// Short interval so "re-polls" tests don't need fake timers.
const FAST_CONFIG: FleetConfig = {
  relays: [{ url: "http://localhost:3000", callerPubkey: GATEKEEPER, roster: [{ pubkey: GATEKEEPER, label: "gatekeeper" }] }],
  pollIntervalMs: 15,
  deadAfterMs: 90_000,
};

const AGENTS_ALIVE: AgentPresence[] = [
  { pubkey: GATEKEEPER, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 0 },
];
const AGENTS_DEAD: AgentPresence[] = [
  { pubkey: GATEKEEPER, label: "gatekeeper", liveness: "dead", rawStatus: null, lastSeenAt: 0 },
];

beforeEach(() => {
  loadConfigMock.mockReset();
  pollFleetMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFleetPresence", () => {
  it("loads /fleet.yaml, polls once, and exposes the classified agents", async () => {
    loadConfigMock.mockResolvedValue(FAST_CONFIG);
    pollFleetMock.mockResolvedValue(AGENTS_ALIVE);

    const { result, unmount } = renderHook(() => useFleetPresence());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents).toEqual(AGENTS_ALIVE);
    expect(result.current.error).toBeNull();
    expect(loadConfigMock).toHaveBeenCalledWith("/fleet.yaml");
    unmount();
  });

  it("re-polls on the configured interval and updates state", async () => {
    loadConfigMock.mockResolvedValue(FAST_CONFIG);
    pollFleetMock.mockResolvedValueOnce(AGENTS_ALIVE).mockResolvedValue(AGENTS_DEAD);

    const { result, unmount } = renderHook(() => useFleetPresence());

    await waitFor(() => expect(result.current.agents).toEqual(AGENTS_DEAD));
    expect(pollFleetMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  it("surfaces a config load error without throwing", async () => {
    loadConfigMock.mockRejectedValue(new Error("fleet.yaml: failed to fetch /fleet.yaml: HTTP 404"));

    const { result, unmount } = renderHook(() => useFleetPresence());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/fleet\.yaml/);
    expect(result.current.agents).toEqual([]);
    expect(pollFleetMock).not.toHaveBeenCalled();
    unmount();
  });

  it("surfaces a poll error while keeping the last-known agents", async () => {
    loadConfigMock.mockResolvedValue(FAST_CONFIG);
    pollFleetMock.mockResolvedValueOnce(AGENTS_ALIVE).mockRejectedValue(new Error("relay down"));

    const { result, unmount } = renderHook(() => useFleetPresence());

    await waitFor(() => expect(result.current.agents).toEqual(AGENTS_ALIVE));
    await waitFor(() => expect(result.current.error).toMatch(/relay down/));

    expect(result.current.agents).toEqual(AGENTS_ALIVE);
    unmount();
  });

  it("stops polling after unmount", async () => {
    loadConfigMock.mockResolvedValue(FAST_CONFIG);
    pollFleetMock.mockResolvedValue(AGENTS_ALIVE);

    const { result, unmount } = renderHook(() => useFleetPresence());
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    const callsAtUnmount = pollFleetMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, FAST_CONFIG.pollIntervalMs * 3));

    expect(pollFleetMock.mock.calls.length).toBe(callsAtUnmount);
  });

  it("does not start polling if unmounted while the config load is still in flight", async () => {
    const configDeferred = deferred<FleetConfig>();
    loadConfigMock.mockReturnValue(configDeferred.promise);

    const { unmount } = renderHook(() => useFleetPresence());
    unmount();
    configDeferred.resolve(FAST_CONFIG);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pollFleetMock).not.toHaveBeenCalled();
  });
});
