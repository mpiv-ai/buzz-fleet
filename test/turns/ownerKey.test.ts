import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, generateSecretKey, nip19 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOwnerSecretKey, parseSecretKey } from "../../src/turns/ownerKey";

// Every key used here is generated fresh per-test — never the real
// ~/dev/buzz-local/*.key material. This module intentionally never reads
// those files or their contents; the daemon (src/server/turnsDaemon.ts)
// reads them at runtime, and this file proves the *mechanism* works using
// synthetic throwaway keys only.

describe("parseSecretKey", () => {
  it("parses a raw 64-character hex secret key", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);

    const parsed = parseSecretKey(hex);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("parses an nsec1-encoded secret key", () => {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);

    const parsed = parseSecretKey(nsec);

    expect(bytesToHex(parsed)).toBe(bytesToHex(secretKey));
  });

  it("trims surrounding whitespace/newlines (files commonly end in one)", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);

    const parsed = parseSecretKey(`  ${hex}\n`);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("throws on a value that is neither valid hex nor nsec", () => {
    expect(() => parseSecretKey("not-a-key")).toThrow();
  });

  it("throws on a hex string of the wrong length", () => {
    expect(() => parseSecretKey("deadbeef")).toThrow();
  });

  it("finds the key on its own line, ignoring a leading comment line", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);

    const parsed = parseSecretKey(`# owner secret key — keep this file mode 600\n${hex}\n`);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("finds an nsec key preceded and followed by comment lines", () => {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);

    const parsed = parseSecretKey(`# generated 2026-04-01\n${nsec}\n# do not commit\n`);

    expect(bytesToHex(parsed)).toBe(bytesToHex(secretKey));
  });

  it("finds a hex key on a labeled line (key: value style)", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);

    const parsed = parseSecretKey(`private_key: ${hex}\n`);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("skips a pubkey line and finds the privkey line elsewhere in a multi-field file", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);
    const pubkeyHex = getPublicKey(secretKey);

    const parsed = parseSecretKey(`public_key: ${pubkeyHex}\nprivate_key: ${hex}\n`);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("skips blank lines", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);

    const parsed = parseSecretKey(`\n\n${hex}\n\n`);

    expect(bytesToHex(parsed)).toBe(hex);
  });

  it("throws when no line contains a valid key", () => {
    expect(() =>
      parseSecretKey("# just a comment\nnothing-here-either\n"),
    ).toThrow();
  });
});

describe("loadOwnerSecretKey — file path", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buzz-fleet-ownerkey-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a hex key from a real file on disk", () => {
    const secretKey = generateSecretKey();
    const hex = bytesToHex(secretKey);
    const keyPath = join(dir, "synthetic-test-owner.key");
    writeFileSync(keyPath, `${hex}\n`, { mode: 0o600 });

    const loaded = loadOwnerSecretKey({ ownerKeyFile: keyPath });

    expect(getPublicKey(loaded)).toBe(getPublicKey(secretKey));
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() =>
      loadOwnerSecretKey({ ownerKeyFile: join(dir, "does-not-exist.key") }),
    ).toThrow();
  });
});

describe("loadOwnerSecretKey — env var", () => {
  const ENV_NAME = "BUZZ_FLEET_TEST_OWNER_KEY";

  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it("reads and parses a hex key from the named environment variable", () => {
    const secretKey = generateSecretKey();
    process.env[ENV_NAME] = bytesToHex(secretKey);

    const loaded = loadOwnerSecretKey({ ownerKeyEnv: ENV_NAME });

    expect(getPublicKey(loaded)).toBe(getPublicKey(secretKey));
  });

  it("throws a clear error when the named environment variable is unset", () => {
    expect(() => loadOwnerSecretKey({ ownerKeyEnv: "BUZZ_FLEET_TEST_UNSET_VAR" })).toThrow(
      /BUZZ_FLEET_TEST_UNSET_VAR/,
    );
  });
});

describe("loadOwnerSecretKey — misconfiguration", () => {
  it("throws when neither ownerKeyFile nor ownerKeyEnv is given", () => {
    expect(() => loadOwnerSecretKey({})).toThrow();
  });
});
