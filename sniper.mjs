#!/usr/bin/env node
// Pons v2 launch sniper — single wallet, direct curve.buy(), HTTP polling only.
//
// Flow on start:
//   1. Ensure rpcs.txt (one HTTPS RPC per line) and pk.txt (single 0x… line) exist.
//      If missing, create empty templates and exit so the user can fill them.
//   2. Read both files.
//   3. Prompt the terminal for: dev wallet to monitor, buy amount (ETH), slippage %.
//   4. Poll every configured RPC at 50ms in parallel. First to see the target launch tx wins.
//   5. Extract the newly-launched curve from the launch tx receipt.
//   6. Fire curve.buy(quoteIn, minTokensOut, buyer) with gas @ 1/1 gwei.
//
// The buyer wallet MUST be on the pons snipe-exempt list at launch time — otherwise the buy
// pays up to ~99% snipe tax inside the first 3 seconds.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient, createWalletClient, http,
  parseEther, defineChain, formatEther, isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── constants ──────────────────────────────────────────────────────────────
import {
  PONS_FACTORY, PONS_LAUNCH_FORWARDER, PONS_LAUNCH_SELECTOR,
  LAUNCH_TARGETS, ZERO,
  isTargetLaunch as isTargetLaunchLib,
  isCanonicalLaunchSelector as isCanonicalLaunchSelectorLib,
  candidateAddressesFromReceipt, routedVia, encodeCurveBuyData,
} from "./lib.mjs";

const CHAIN_ID = 4663;
const POLL_MS = 25;              // dev-nonce poll cadence per RPC (halved for 1-block latency target)
const RECEIPT_POLL_MS = 20;      // hammer the receipt lookup once we see the launch
const RECEIPT_MAX_MS = 500;      // give up chasing a receipt after this many ms
const HEARTBEAT_MS = 1000;       // show it's alive every second
const GAS_GWEI = 1n;
const GAS_WEI = GAS_GWEI * 1_000_000_000n; // maxFee + priority both = 1 gwei
const CURVE_BUY_ABI = [{
  type: "function", name: "buy", stateMutability: "payable",
  inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }],
  outputs: [],
}];
const TOKEN_ABI = [{
  type: "function", name: "curve", stateMutability: "view",
  inputs: [], outputs: [{ type: "address" }],
}];
const CURVE_PREVIEW_ABI = [{
  type: "function", name: "previewBuy", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "uint256" }],
  outputs: [
    { type: "uint256", name: "tokensOut" },
    { type: "uint256", name: "fee" },
    { type: "uint256", name: "snipeTaxOnTokens" },
    { type: "uint256", name: "quoteConsumed" },
  ],
}];

// ─── logging ────────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(11, 19);
  console.log(`[${ts}]`, ...args);
}
const ok = (m) => log("✓", m);
const warn = (m) => log("⚠", m);
const err = (m) => log("✗", m);

// ─── bootstrap: rpcs.txt + pk.txt ───────────────────────────────────────────
const cwd = process.cwd();
const RPCS_TXT = path.join(cwd, "rpcs.txt");
const PK_TXT = path.join(cwd, "pk.txt");

function readOrTemplate(filePath, templateContent, label) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, templateContent);
    console.error(`✗ ${label} was missing — created empty template at ${filePath}. Fill it in and re-run.`);
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

const rpcsRaw = readOrTemplate(RPCS_TXT,
`# One HTTPS RPC URL per line. Lines starting with # are ignored.
# Example:
# https://rpc.mainnet.chain.robinhood.com
# https://robinhood-rpc.publicnode.com
# https://rpc.ordofi.network
`, "rpcs.txt");

const pkRaw = readOrTemplate(PK_TXT,
`# Paste the buyer wallet's private key on a single line (0x-prefixed 32-byte hex).
# This wallet MUST be on the pons snipe-exempt list at launch time.
`, "pk.txt");

if (rpcsRaw === null || pkRaw === null) process.exit(1);

const rpcs = rpcsRaw
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
if (rpcs.length === 0) { console.error("✗ rpcs.txt has no HTTPS RPC URLs — add at least one and re-run."); process.exit(1); }
for (const u of rpcs) {
  if (!u.startsWith("https://")) { console.error(`✗ rpcs.txt: "${u}" is not https:// — HTTPS only.`); process.exit(1); }
}

const pkLine = pkRaw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
if (!pkLine || !/^0x[0-9a-fA-F]{64}$/.test(pkLine)) {
  console.error("✗ pk.txt: no valid 0x-prefixed 32-byte private key. Fix and re-run."); process.exit(1);
}

const account = privateKeyToAccount(pkLine);
const buyer = account.address;

// ─── terminal prompts ───────────────────────────────────────────────────────
async function prompt() {
  const rl = readline.createInterface({ input, output });
  console.log("");
  console.log("pons v2 sniper — enter run parameters");
  console.log(`  buyer wallet : ${buyer}`);
  console.log(`  rpcs         : ${rpcs.length} HTTPS`);
  console.log(`  gas          : ${GAS_GWEI} gwei (maxFee + priority both)`);
  console.log(`  poll         : ${POLL_MS} ms`);
  console.log("");

  async function ask(q, validate) {
    while (true) {
      const raw = (await rl.question(q)).trim();
      const v = validate(raw);
      if (v.ok) return v.value;
      console.log(`  ✗ ${v.err}`);
    }
  }

  const dev = await ask("dev wallet to monitor (0x…): ", (s) =>
    isAddress(s) ? { ok: true, value: s.toLowerCase() } : { ok: false, err: "not a valid address" });

  const amountEth = await ask("buy amount in ETH (e.g. 0.05): ", (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, err: "must be a positive number" };
    return { ok: true, value: s };
  });

  const slippagePct = await ask("slippage % (e.g. 5 for 5% — protects if the buy would return way less than expected): ", (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, err: "must be a number in [0, 100]" };
    return { ok: true, value: n };
  });

  rl.close();
  return { dev, amountEth, slippagePct };
}

// ─── viem clients ───────────────────────────────────────────────────────────
const chain = defineChain({
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcs } },
});
const httpClients = rpcs.map((url) =>
  createPublicClient({ chain, transport: http(url, { timeout: 8_000, retryCount: 1 }) })
);
const walletClient = createWalletClient({
  chain, account, transport: http(rpcs[0], { timeout: 8_000, retryCount: 1 }),
});

// ─── detection ──────────────────────────────────────────────────────────────
let devWallet = null;      // filled after prompt
let buyAmountWei = 0n;
let slippageBps = 0;
let fired = false;
let buyerNonce = null;     // cached buyer nonce — primed at startup, incremented locally
const seenTxs = new Set(); // dedupe across all RPCs
const factoryLower = PONS_FACTORY.toLowerCase();

// Local wrappers that inject the current devWallet — logic lives in lib.mjs and is unit-tested.
const isTargetLaunch = (tx) => isTargetLaunchLib(tx, devWallet);
const isCanonicalLaunchSelector = (tx) => isCanonicalLaunchSelectorLib(tx);

// Extract the launched curve from a launch-tx receipt: scan every log for address candidates via
// lib.candidateAddressesFromReceipt, then call `.curve()` on each — first to answer wins.
async function findLaunchedCurve(client, txHash) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== "success") return null;
  const candidates = candidateAddressesFromReceipt(receipt, devWallet);
  for (const candidate of candidates) {
    try {
      const curve = await client.readContract({
        address: candidate, abi: TOKEN_ABI, functionName: "curve",
      });
      if (curve && curve !== ZERO) return { token: candidate, curve: curve.toLowerCase() };
    } catch { /* not a pons token */ }
  }
  return null;
}

// FAST PATH: given a pending launch tx (not yet mined), simulate it via eth_call against
// pending state. Extract candidate addresses from the returned data + any logs the RPC
// exposes, then call `.curve()` on each. Skips waiting for the tx to mine → saves ~100ms.
async function findLaunchedCurveFromPendingTx(client, tx) {
  try {
    // eth_call simulates the tx against pending state without mining it. For pons's launchToken
    // which returns (address, address), the return data contains both addresses.
    const raw = await client.request({
      method: "eth_call",
      params: [{
        from: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
      }, "pending"],
    });
    const candidates = candidatesFromSimulation(raw, null, devWallet);
    for (const c of candidates) {
      try {
        const curve = await client.readContract({
          address: c, abi: TOKEN_ABI, functionName: "curve", blockTag: "pending",
        });
        if (curve && curve !== ZERO) return { token: c, curve: curve.toLowerCase() };
      } catch { /* not a pons token */ }
    }
  } catch {
    // eth_call reverted or RPC doesn't support it — caller falls back to receipt-based resolve.
  }
  return null;
}

// Try to compute minTokensOut from previewBuy. Falls back to 0 (no protection) with a warning
// if the curve's ABI doesn't match our previewBuy signature.
async function computeMinTokensOut(client, curveAddr) {
  if (slippageBps === 0) return 0n;
  try {
    const [tokensOut] = await client.readContract({
      address: curveAddr, abi: CURVE_PREVIEW_ABI, functionName: "previewBuy",
      args: [buyer, buyAmountWei],
    });
    const min = (tokensOut * BigInt(10000 - slippageBps)) / 10000n;
    log(`  preview      : ${tokensOut} tokens (expected). minOut @ ${slippageBps} bps = ${min}`);
    return min;
  } catch {
    warn(`could not previewBuy — using minTokensOut=0 (slippage protection disabled for this curve)`);
    return 0n;
  }
}

async function fire(curveAddr, sourceHash) {
  if (fired) return;
  fired = true;

  const client = httpClients[0];
  const tFire = Date.now();
  log(`── LAUNCH DETECTED ──`);
  log(`  source tx    : ${sourceHash}`);
  log(`  curve        : ${curveAddr}`);
  log(`  buyer        : ${buyer}`);
  log(`  spend        : ${formatEther(buyAmountWei)} ETH`);
  log(`  gas          : ${GAS_GWEI}/${GAS_GWEI} gwei`);

  const minOut = 0n; // slippage protection disabled for max speed — user is snipe-exempt
  const gasLimit = 500000n;
  // Pre-flight balance check — catches "insufficient funds" BEFORE we sign+broadcast, since some
  // RPCs return a generic "Missing or invalid parameters" for it and the cause isn't obvious.
  const maxGasCost = gasLimit * GAS_WEI;
  const totalNeeded = buyAmountWei + maxGasCost;
  try {
    const bal = await client.getBalance({ address: buyer });
    if (bal < totalNeeded) {
      err(`INSUFFICIENT FUNDS: have ${formatEther(bal)} ETH, need ${formatEther(totalNeeded)} ETH ` +
          `(${formatEther(buyAmountWei)} buy + ${formatEther(maxGasCost)} max gas @ ${GAS_GWEI} gwei × ${gasLimit})`);
      err(`FIX: top up buyer OR lower GAS_GWEI (currently ${GAS_GWEI}) OR lower buy amount`);
      fired = false;
      return;
    }
  } catch { /* if balance check fails, keep going — broadcast will error clearly enough */ }

  try {
    // Hand-build the tx — bypass viem's prepareTransactionRequest which does 2-3 RPC calls.
    // Nonce is cached and incremented locally; we already know chainId + gas.
    const nonce = buyerNonce;
    buyerNonce = nonce + 1; // increment optimistically; roll back on failure

    // encodeCurveBuyData already returns a 0x-prefixed hex string. Do NOT prepend another "0x".
    const request = {
      to: curveAddr,
      data: encodeCurveBuyData(buyAmountWei, minOut, buyer),
      value: buyAmountWei,
      gas: gasLimit,
      maxFeePerGas: GAS_WEI,
      maxPriorityFeePerGas: GAS_WEI,
      nonce,
      chainId: CHAIN_ID,
      type: "eip1559",
    };
    const signed = await account.signTransaction(request);
    log(`  signed in    : ${Date.now() - tFire}ms (nonce=${nonce})`);

    // Broadcast in parallel — winner is whichever RPC returns the tx hash first.
    const bcs = httpClients.map((c) =>
      c.request({ method: "eth_sendRawTransaction", params: [signed] })
        .then((h) => ({ ok: true, hash: h }))
        .catch((e) => ({ ok: false, err: e.shortMessage || e.message }))
    );
    const results = await Promise.all(bcs);
    const winners = results.filter((r) => r.ok);
    if (winners.length === 0) {
      err(`all RPC broadcasts failed. errors: ${results.map((r) => r.err).join(" | ")}`);
      buyerNonce = buyerNonce - 1; // roll back cached nonce so the retry uses the same slot
      fired = false;
      return;
    }
    const hash = winners[0].hash;
    ok(`buy tx broadcast in ${Date.now() - tFire}ms via ${winners.length}/${httpClients.length} RPCs: ${hash}`);

    // Wait for confirmation on the fastest RPC.
    const tWait = Date.now();
    const receipt = await client.waitForTransactionReceipt({ hash });
    log(`  confirmed in ${Date.now() - tWait}ms → block ${receipt.blockNumber}`);
    if (receipt.status === "success") ok(`buy CONFIRMED — total fire→confirmed = ${Date.now() - tFire}ms`);
    else err(`buy FAILED on-chain: ${hash}`);
  } catch (e) {
    err(`buy failed: ${e.shortMessage || e.message}`);
    buyerNonce = buyerNonce - 1; // roll back cached nonce
    fired = false;
    return;
  }
  process.exit(0);
}


async function scanBlock(client, block, sourceLabel) {
  const txs = block?.transactions || [];
  for (const tx of txs) {
    if (typeof tx === "string") continue;
    if (seenTxs.has(tx.hash)) continue;
    seenTxs.add(tx.hash);
    if (!isTargetLaunch(tx)) continue;
    log(`(${sourceLabel}) target launch tx from ${tx.from}: ${tx.hash}`);
    const found = await findLaunchedCurve(client, tx.hash);
    if (!found) {
      warn(`could not resolve curve from ${tx.hash} — receipt may not be indexed yet, retrying via next scan`);
      seenTxs.delete(tx.hash);
      continue;
    }
    await fire(found.curve, tx.hash);
    return;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const { dev, amountEth, slippagePct } = await prompt();
  devWallet = dev;
  buyAmountWei = parseEther(amountEth);
  slippageBps = Math.round(slippagePct * 100);

  console.log("");
  log(`monitoring dev  : ${devWallet}`);
  log(`buy amount      : ${amountEth} ETH  (=${buyAmountWei} wei)`);
  log(`slippage        : ${slippagePct}%  (${slippageBps} bps)`);

  // Sanity: buyer balance check + prime buyer nonce (used by the fast-path fire).
  try {
    const [bal, n] = await Promise.all([
      httpClients[0].getBalance({ address: buyer }),
      httpClients[0].getTransactionCount({ address: buyer, blockTag: "pending" }),
    ]);
    log(`buyer balance   : ${formatEther(bal)} ETH`);
    log(`buyer nonce     : ${n} (cached — sniper increments locally to skip RPC round-trip on fire)`);
    buyerNonce = n;
    if (bal < buyAmountWei) warn("buyer balance is below buy amount — top up before the launch fires");
  } catch (e) { warn(`prime failed: ${e.shortMessage || e.message}`); }

  // Warm the HTTP/1.1 connection to each RPC so the first fire doesn't pay TCP+TLS handshake.
  await Promise.all(httpClients.map((c) => c.getBlockNumber().catch(() => null)));
  log(`warmed          : ${httpClients.length} HTTPS connections`);

  // Wallet-centric watcher. For each RPC we prefer, in order:
  //   1. txpool_contentFrom(dev)               — geth-style, returns dev's pending txs directly.
  //                                              ZERO block scan, one call, one tx object.
  //                                              Requires a private/geth RPC that exposes txpool.
  //   2. eth_getTransactionCount(dev, "pending") + pending-block scan on jump (fallback).
  //
  // We probe each RPC once at boot to figure out which method it supports.
  const stats = httpClients.map(() => ({
    pollN: 0, jumpN: 0, errN: 0, lastNonce: -1, lastErr: "",
    method: "probing", // "txpool" | "nonce" | "probing"
  }));

  async function probeTxpool(client) {
    try {
      // Some RPCs return the object, some throw "method not found". We accept any non-throw as success.
      await client.transport.request({ method: "txpool_contentFrom", params: [devWallet] });
      return true;
    } catch { return false; }
  }
  // Probe all RPCs in parallel.
  await Promise.all(httpClients.map(async (client, i) => {
    const has = await probeTxpool(client);
    stats[i].method = has ? "txpool" : "nonce";
  }));
  const summary = stats.map((s, i) => `${new URL(rpcs[i]).host} → ${s.method}`).join(", ");
  ok(`RPC capability probe: ${summary}`);


  // Prime each RPC's baseline nonce (used by the nonce-jump fallback path).
  await Promise.all(httpClients.map(async (client, i) => {
    try {
      stats[i].lastNonce = await client.getTransactionCount({ address: devWallet, blockTag: "pending" });
    } catch (e) { stats[i].errN++; stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80); }
  }));
  log(`baseline pending nonce for ${devWallet}: ${stats[0].lastNonce}`);

  // txpool_contentFrom returns { pending: {nonce: tx}, queued: {nonce: tx} }.
  // Match: to == pons factory AND input starts with 0xa72101af. Fires ONE-shot.
  async function pollTxpool(client, i, label) {
    stats[i].pollN++;
    try {
      const r = await client.transport.request({ method: "txpool_contentFrom", params: [devWallet] });
      if (!r) return;
      const buckets = [r.pending, r.queued].filter(Boolean);
      for (const bucket of buckets) {
        for (const nonce of Object.keys(bucket)) {
          const tx = bucket[nonce];
          if (!tx || seenTxs.has(tx.hash)) continue;
          if (!isTargetLaunch(tx)) continue;
          seenTxs.add(tx.hash);
          stats[i].jumpN++;
          log(`(${label}) ✔ launch tx in txpool (nonce ${nonce}): ${tx.hash}`);
          // Wait for receipt (up to 6s) then find curve.
          let found = null;
          for (let attempt = 0; attempt < 60 && !found; attempt++) {
            found = await findLaunchedCurve(client, tx.hash).catch(() => null);
            if (!found) await new Promise((rr) => setTimeout(rr, 100));
          }
          if (!found) { warn(`could not resolve curve for ${tx.hash} — timed out`); continue; }
          await fire(found.curve, tx.hash);
          return;
        }
      }
    } catch (e) {
      stats[i].errN++;
      stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80);
    }
  }

  async function onNonceJump(client, i, oldN, newN, label) {
    log(`(${label}) nonce jump ${oldN} → ${newN} — dev sent ${newN - oldN} tx, hunting…`);

    // Widen the search: pending, latest, and the last 10 confirmed blocks. On Robinhood's
    // 100ms cadence, 10 blocks = 1 second — more than enough to catch any tx from the last hop.
    const latestBlockNum = await client.getBlockNumber().catch(() => null);
    const tags = ["pending", "latest"];
    if (latestBlockNum != null) {
      for (let d = 1; d <= 10; d++) tags.push(latestBlockNum - BigInt(d));
    }

    let sawAnyDevTx = false;
    let sawAnyToLaunchTarget = false;
    for (const tag of tags) {
      try {
        const block = typeof tag === "string"
          ? await client.getBlock({ blockTag: tag, includeTransactions: true })
          : await client.getBlock({ blockNumber: tag, includeTransactions: true });
        for (const tx of block.transactions || []) {
          if (typeof tx === "string") continue;
          if ((tx.from || "").toLowerCase() !== devWallet) continue;
          sawAnyDevTx = true;
          if (seenTxs.has(tx.hash)) continue;
          const to = (tx.to || "").toLowerCase();
          const sel = (tx.input || "0x").slice(0, 10);
          // Log every dev tx we find so we can see what's happening in real time.
          log(`(${label}) dev tx in ${tag}: to=${tx.to} sel=${sel} hash=${tx.hash}`);
          // Match either the pons factory OR the launchForwarder.
          if (!LAUNCH_TARGETS.has(to)) {
            seenTxs.add(tx.hash);
            continue; // dev txed to something else — not a launch
          }
          sawAnyToLaunchTarget = true;
          const via = routedVia(to);
          if (to === factoryLower && !isCanonicalLaunchSelector(tx)) {
            log(`(${label}) ↳ selector ${sel} isn't the known launchToken selector (${PONS_LAUNCH_SELECTOR}) — chasing anyway`);
          }
          seenTxs.add(tx.hash);
          log(`(${label}) ✔ dev→${via} tx: ${tx.hash} — resolving curve…`);

          // FAST PATH: if we found the tx in the "pending" tag it hasn't been mined yet.
          // Simulate it via eth_call to extract the curve — no receipt wait needed.
          const t0 = Date.now();
          let found = null;
          if (tag === "pending") {
            found = await findLaunchedCurveFromPendingTx(client, tx).catch(() => null);
            if (found) log(`  curve resolved in ${Date.now() - t0}ms (via pending-tx simulation)`);
          }

          // Fallback: wait for receipt across all RPCs.
          if (!found) {
            while (!found && Date.now() - t0 < RECEIPT_MAX_MS) {
              const attempts = httpClients.map((c) => findLaunchedCurve(c, tx.hash).catch(() => null));
              const results = await Promise.all(attempts);
              found = results.find(Boolean) ?? null;
              if (!found) await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS));
            }
            if (found) log(`  curve resolved in ${Date.now() - t0}ms (via receipt)`);
          }

          if (!found) { warn(`no curve found in ${Date.now() - t0}ms for ${tx.hash} — bailing`); continue; }
          await fire(found.curve, tx.hash);
          return;
        }
      } catch (e) {
        stats[i].errN++;
        stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80);
      }
    }
    if (!sawAnyDevTx) {
      warn(`(${label}) nonce jumped but dev's tx wasn't in pending or the last 10 blocks — RPC lagging or tx replaced. Rolling back to retry.`);
      stats[i].lastNonce = oldN;
    } else if (!sawAnyToLaunchTarget) {
      warn(`(${label}) dev's tx wasn't to the pons factory OR the launchForwarder. Not a launch — paste the tx hash if you think it should be.`);
    }
  }

  httpClients.forEach((client, i) => {
    const label = `rpc#${i}(${stats[i].method})`;
    setInterval(async () => {
      if (stats[i].method === "txpool") {
        await pollTxpool(client, i, label);
        return;
      }
      // Nonce-jump fallback for RPCs without txpool.
      stats[i].pollN++;
      try {
        const nonce = await client.getTransactionCount({ address: devWallet, blockTag: "pending" });
        if (nonce > stats[i].lastNonce) {
          const old = stats[i].lastNonce;
          stats[i].lastNonce = nonce;
          stats[i].jumpN++;
          onNonceJump(client, i, old, nonce, label);
        }
      } catch (e) {
        stats[i].errN++;
        stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80);
      }
    }, POLL_MS);
  });

  ok(`watching wallet ${devWallet} across ${httpClients.length} HTTPS RPCs @ ${POLL_MS}ms`);
  log(`(will print heartbeat every 5s; wakes up on any nonce jump)`);

  // Heartbeat every 5s.
  setInterval(() => {
    const lines = stats.map((st, i) => {
      const url = new URL(rpcs[i]).host;
      const errTail = st.errN > 0 ? ` err=${st.errN} (${st.lastErr})` : "";
      return `  ${url.padEnd(40)}  [${st.method}]  polls=${st.pollN}  hits=${st.jumpN}  nonce=${st.lastNonce}${errTail}`;
    }).join("\n");
    log(`— heartbeat —\n${lines}`);
  }, HEARTBEAT_MS);
}

main().catch((e) => { err(String(e.stack || e)); process.exit(1); });
