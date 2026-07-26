// Mint a NIP-OA (Owner Attestation) auth tag so the buzz relay can materialize
// the agent -> owner mapping (users.agent_owner_pubkey) on NIP-42 AUTH.
//
// Spec: block/buzz docs/nips/NIP-OA.md
//   preimage = "nostr:agent-auth:" || <agent_pubkey_hex> || ":" || <conditions>
//   message  = SHA256(preimage)
//   sig      = BIP-340 Schnorr over message, signed by the OWNER secret key
//   tag      = ["auth", <owner_pubkey_hex>, <conditions>, <sig_hex>]
//
// Secrets: the owner secret is read from the OWNER_PRIV env var only. It is
// never printed, never written to disk, and never passed in argv. Everything
// this script emits (pubkeys, signature, tag) is public data.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { writeFileSync } from 'node:fs';

const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => Buffer.from(h, 'hex');
const utf8 = (s) => new TextEncoder().encode(s);

const preimage = (agentPubHex, conditions) =>
  `nostr:agent-auth:${agentPubHex}:${conditions}`;

const digest = (agentPubHex, conditions) =>
  sha256(utf8(preimage(agentPubHex, conditions)));

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// ---------------------------------------------------------------------------
// Gate 1: reproduce the published NIP-OA test vector before touching real keys.
// This proves the preimage construction and the signature scheme independently
// of nonce determinism (we verify the published signature rather than re-sign).
// ---------------------------------------------------------------------------
console.log('NIP-OA test vector check:');
const V = {
  ownerPub: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  agentPub: 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  conditions: 'kind=1&created_at<1713957000',
  sha256: '08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6',
  sig: '8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369',
};
const vDigest = digest(V.agentPub, V.conditions);
assert(toHex(vDigest) === V.sha256, `sha256(preimage) matches vector ${V.sha256}`);
assert(
  schnorr.verify(fromHex(V.sig), vDigest, fromHex(V.ownerPub)) === true,
  'published vector signature verifies against computed digest',
);

// ---------------------------------------------------------------------------
// Mint the real tag.
// ---------------------------------------------------------------------------
const ownerPriv = process.env.OWNER_PRIV;
const agentPub = process.env.AGENT_PUB ?? process.argv[2];
const conditions = process.env.NIP_OA_CONDITIONS ?? ''; // empty == no extra constraints
const outFile = process.argv[3] ?? 'nip-oa-tag.json';

if (!ownerPriv || !/^[0-9a-f]{64}$/.test(ownerPriv)) {
  console.error('OWNER_PRIV env var must be set to 64-char lowercase hex');
  process.exit(1);
}
if (!agentPub || !/^[0-9a-f]{64}$/.test(agentPub)) {
  console.error('AGENT_PUB env var (or argv[2]) must be 64-char lowercase hex');
  process.exit(1);
}

const ownerPrivBytes = fromHex(ownerPriv);
const ownerPub = toHex(schnorr.getPublicKey(ownerPrivBytes));

console.log('\nMinting:');
assert(ownerPub !== agentPub, 'owner and agent pubkeys differ (self-attestation rejected)');

const msg = digest(agentPub, conditions);
const sig = schnorr.sign(msg, ownerPrivBytes);
assert(
  schnorr.verify(sig, msg, fromHex(ownerPub)) === true,
  'minted signature self-verifies',
);

const tag = JSON.stringify(['auth', ownerPub, conditions, toHex(sig)]);
writeFileSync(outFile, tag);

console.log('\nowner pubkey :', ownerPub);
console.log('agent pubkey :', agentPub);
console.log('conditions   :', JSON.stringify(conditions));
console.log('tag written  :', outFile);
console.log('tag          :', tag);
