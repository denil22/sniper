// Test suite for the pure logic of the sniper. Run with:  node --test test.mjs
//
// The bugs we're guarding against:
//   1. Launch detection failing when pons routes through the launchForwarder instead of the
//      factory directly. This happened twice — filter said "factory only", missed forwarder txs.
//   2. Curve resolver only scanning logs from the factory. Widened it to scan every log's
//      addresses/topics/data — this test locks that behavior in.
//   3. Selector too strict — pons could rev their factory to a new selector and we'd miss it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PONS_FACTORY,
  PONS_LAUNCH_FORWARDER,
  PONS_LAUNCH_SELECTOR,
  LAUNCH_TARGETS,
  ZERO,
  isTargetLaunch,
  isCanonicalLaunchSelector,
  candidateAddressesFromReceipt,
  candidatesFromSimulation,
  routedVia,
  encodeCurveBuyData,
} from "./lib.mjs";

const DEV = "0x9a4119f7995979cb075be261fc5bd503e9b78fee";
const OTHER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RANDOM_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_ADDR = "0x5830640b5de07898d28ec384a0c6b0e27a27a20f";
const CURVE_ADDR = "0xdd52b7445d7edf7595c8e771641c2a15168f1fc1";

const mkTx = (o) => ({ hash: "0xtx", input: "0x00", ...o });

// ─── isTargetLaunch ─────────────────────────────────────────────────────────
test("isTargetLaunch: direct factory call from dev → match", () => {
  const tx = mkTx({ from: DEV, to: PONS_FACTORY, input: PONS_LAUNCH_SELECTOR + "aa".repeat(4) });
  assert.equal(isTargetLaunch(tx, DEV), true);
});

test("isTargetLaunch: forwarder call from dev → match (regression against the factory-only bug)", () => {
  const tx = mkTx({ from: DEV, to: PONS_LAUNCH_FORWARDER, input: "0xf85f8e41deadbeef" });
  assert.equal(isTargetLaunch(tx, DEV), true);
});

test("isTargetLaunch: factory call from someone else → no match", () => {
  const tx = mkTx({ from: OTHER, to: PONS_FACTORY, input: PONS_LAUNCH_SELECTOR });
  assert.equal(isTargetLaunch(tx, DEV), false);
});

test("isTargetLaunch: dev calls a random contract → no match", () => {
  const tx = mkTx({ from: DEV, to: RANDOM_CONTRACT, input: PONS_LAUNCH_SELECTOR });
  assert.equal(isTargetLaunch(tx, DEV), false);
});

test("isTargetLaunch: unknown selector but to == factory → still matches (selector filter dropped intentionally)", () => {
  const tx = mkTx({ from: DEV, to: PONS_FACTORY, input: "0xdeadbeef" + "00".repeat(4) });
  assert.equal(isTargetLaunch(tx, DEV), true);
});

test("isTargetLaunch: dev tx to address in mixed case still matches", () => {
  const mixed = "0X7Ed598BCEF8BD9EDD8C97A195C6D13F40801EC7E";
  const tx = mkTx({ from: DEV, to: mixed, input: PONS_LAUNCH_SELECTOR });
  assert.equal(isTargetLaunch(tx, DEV), true);
});

test("isTargetLaunch: malformed txs are rejected safely", () => {
  assert.equal(isTargetLaunch(null, DEV), false);
  assert.equal(isTargetLaunch({}, DEV), false);
  assert.equal(isTargetLaunch({ hash: "0x", to: PONS_FACTORY }, DEV), false); // no `from`
  assert.equal(isTargetLaunch({ hash: "0x", from: DEV }, DEV), false); // no `to`
});

// ─── isCanonicalLaunchSelector ──────────────────────────────────────────────
test("isCanonicalLaunchSelector: canonical selector → true", () => {
  const tx = mkTx({ input: PONS_LAUNCH_SELECTOR + "00".repeat(4) });
  assert.equal(isCanonicalLaunchSelector(tx), true);
});
test("isCanonicalLaunchSelector: forwarder selector → false", () => {
  const tx = mkTx({ input: "0xf85f8e41" + "00".repeat(4) });
  assert.equal(isCanonicalLaunchSelector(tx), false);
});

// ─── LAUNCH_TARGETS set integrity ───────────────────────────────────────────
test("LAUNCH_TARGETS: contains both factory and forwarder, both lowercase", () => {
  assert.ok(LAUNCH_TARGETS.has(PONS_FACTORY.toLowerCase()));
  assert.ok(LAUNCH_TARGETS.has(PONS_LAUNCH_FORWARDER.toLowerCase()));
  assert.equal(LAUNCH_TARGETS.size, 2);
});

// ─── candidateAddressesFromReceipt ──────────────────────────────────────────
// Real receipt from tx 0xac325885… (user's own launch through the forwarder). We assert the
// resolver picks up BOTH the token and the curve — from logs emitted by contracts OTHER than the
// factory (token itself, forwarder, curve). This test locks in the "scan every log" widening.
test("candidateAddressesFromReceipt: extracts token + curve from a real forwarder-routed launch", () => {
  const receipt = {
    logs: [
      // Transfer(from=0x0, to=curve) — emitted by TOKEN
      {
        address: TOKEN_ADDR,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x" + "0".repeat(64),
          "0x000000000000000000000000" + CURVE_ADDR.slice(2),
        ],
        data: "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000",
      },
      // TokenLaunched(token) — emitted by CURVE (not factory)
      {
        address: CURVE_ADDR,
        topics: ["0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6"],
        data: "0x000000000000000000000000" + TOKEN_ADDR.slice(2),
      },
      // Launched(token, curve, dev) — emitted by FACTORY
      {
        address: PONS_FACTORY,
        topics: [
          "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
          "0x000000000000000000000000" + TOKEN_ADDR.slice(2),
          "0x000000000000000000000000" + CURVE_ADDR.slice(2),
          "0x000000000000000000000000" + DEV.slice(2),
        ],
        data: "0x",
      },
      // ForwarderRelayed — emitted by FORWARDER
      {
        address: PONS_LAUNCH_FORWARDER,
        topics: [
          "0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37",
          "0x000000000000000000000000" + TOKEN_ADDR.slice(2),
          "0x000000000000000000000000" + CURVE_ADDR.slice(2),
        ],
        data: "0x",
      },
    ],
  };
  const candidates = candidateAddressesFromReceipt(receipt, DEV);
  const set = new Set(candidates);
  assert.ok(set.has(TOKEN_ADDR.toLowerCase()), `expected token ${TOKEN_ADDR} in candidates`);
  assert.ok(set.has(CURVE_ADDR.toLowerCase()), `expected curve ${CURVE_ADDR} in candidates`);
  // Infra addresses must NOT leak in.
  assert.ok(!set.has(PONS_FACTORY.toLowerCase()), "factory should be excluded");
  assert.ok(!set.has(PONS_LAUNCH_FORWARDER.toLowerCase()), "forwarder should be excluded");
  assert.ok(!set.has(DEV), "dev wallet should be excluded");
  assert.ok(!set.has(ZERO), "zero addr should be excluded");
});

test("candidateAddressesFromReceipt: no logs → empty array (not a throw)", () => {
  assert.deepEqual(candidateAddressesFromReceipt({ logs: [] }, DEV), []);
  assert.deepEqual(candidateAddressesFromReceipt({}, DEV), []);
});

// ─── routedVia ──────────────────────────────────────────────────────────────
test("routedVia: labels factory / forwarder / unknown correctly", () => {
  assert.equal(routedVia(PONS_FACTORY), "factory");
  assert.equal(routedVia(PONS_FACTORY.toLowerCase()), "factory");
  assert.equal(routedVia(PONS_LAUNCH_FORWARDER), "forwarder");
  assert.equal(routedVia("0x0000000000000000000000000000000000000123"), "unknown");
  assert.equal(routedVia(undefined), "unknown");
});

// ─── encodeCurveBuyData ─────────────────────────────────────────────────────
test("encodeCurveBuyData: produces correct selector + 3 padded args", () => {
  const buyer = "0x1111111111111111111111111111111111111111";
  const data = encodeCurveBuyData(1000000000000000n, 42n, buyer); // 0.001 ETH, minOut=42
  assert.equal(data.slice(0, 10), "0x59a87bc1");
  assert.equal(data.length, 10 + 64 * 3);
  // arg1 = 0x0000…038d7ea4c68000 (1e15 in hex = 38d7ea4c68000)
  assert.equal(data.slice(10, 74), "0".repeat(64 - "38d7ea4c68000".length) + "38d7ea4c68000");
  // arg2 = 0x0000…002a
  assert.equal(data.slice(74, 138), "0".repeat(62) + "2a");
  // arg3 = padded buyer
  assert.equal(data.slice(138), "0".repeat(24) + buyer.slice(2));
});

test("encodeCurveBuyData: zero args produce all zeros after selector", () => {
  const data = encodeCurveBuyData(0n, 0n, "0x0000000000000000000000000000000000000000");
  assert.equal(data, "0x59a87bc1" + "0".repeat(64 * 3));
});

test("encodeCurveBuyData: returns EXACTLY one leading 0x — never double-prefixed (regression)", () => {
  // Bug that bit us: caller wrote `"0x" + encodeCurveBuyData(...)`, producing "0x0x59a87bc1..."
  // which viem's hex parser rejected with "Invalid byte sequence". This test locks in that
  // encodeCurveBuyData is directly usable as a viem `data` field WITHOUT any extra prefixing.
  const data = encodeCurveBuyData(5_000_000_000_000_000n, 0n, "0x1111111111111111111111111111111111111111");
  assert.ok(data.startsWith("0x"), "must start with 0x");
  assert.ok(!data.startsWith("0x0x"), "must not double-prefix");
  // Must be a valid hex string throughout
  assert.match(data, /^0x[0-9a-f]+$/i, "must be pure lowercase hex after 0x");
  // Length must be exactly 2 + 8 selector + 3*64 args = 202
  assert.equal(data.length, 2 + 8 + 3 * 64);
});

// ─── candidatesFromSimulation ───────────────────────────────────────────────
// pons's launchToken returns (address token, address curve). Simulation via eth_call gives us
// the packed return data. We must extract both addresses without waiting for the tx to mine.
test("candidatesFromSimulation: extracts token + curve from ABI-encoded (address, address) return", () => {
  const token = "5830640b5de07898d28ec384a0c6b0e27a27a20f";
  const curve = "dd52b7445d7edf7595c8e771641c2a15168f1fc1";
  const returnData = "0x" +
    "0".repeat(24) + token +
    "0".repeat(24) + curve;
  const cs = candidatesFromSimulation(returnData, null, DEV);
  const set = new Set(cs);
  assert.ok(set.has("0x" + token), "expected token in candidates");
  assert.ok(set.has("0x" + curve), "expected curve in candidates");
});

test("candidatesFromSimulation: also processes logs when provided (debug_traceCall path)", () => {
  const logs = [{
    address: CURVE_ADDR,
    topics: ["0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6"],
    data: "0x000000000000000000000000" + TOKEN_ADDR.slice(2),
  }];
  const cs = candidatesFromSimulation(null, logs, DEV);
  const set = new Set(cs);
  assert.ok(set.has(TOKEN_ADDR.toLowerCase()), "expected token from log data");
  assert.ok(set.has(CURVE_ADDR.toLowerCase()), "expected curve (log.address)");
});

test("candidatesFromSimulation: excludes factory / forwarder / dev / zero even from return data", () => {
  const returnData = "0x" +
    "0".repeat(24) + PONS_FACTORY.slice(2).toLowerCase() +
    "0".repeat(24) + PONS_LAUNCH_FORWARDER.slice(2).toLowerCase() +
    "0".repeat(24) + DEV.slice(2) +
    "0".repeat(64); // zero address
  const cs = candidatesFromSimulation(returnData, null, DEV);
  assert.equal(cs.length, 0, "all candidates were infra addrs and should be filtered");
});

test("candidatesFromSimulation: handles empty inputs safely", () => {
  assert.deepEqual(candidatesFromSimulation("", null, DEV), []);
  assert.deepEqual(candidatesFromSimulation(null, [], DEV), []);
  assert.deepEqual(candidatesFromSimulation("0x", null, DEV), []);
});
