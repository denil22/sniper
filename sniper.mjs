#!/usr/bin/env node
// Pons v2 launch sniper — supports 1..N buyer wallets, direct curve.buy(), HTTPS polling only.
//
// Flow on start:
//   1. Ensure rpcs.txt (one HTTPS RPC per line) and pk.txt (one 0x… private key per line) exist.
//      If missing, create empty templates and exit so the user can fill them.
//   2. Read both files. pk.txt with multiple lines → each wallet fires in parallel (fanout snipe).
//   3. Prompt the terminal for: dev wallet to monitor, buy amount PER WALLET (ETH), slippage %.
//   4. Poll every configured RPC at 25ms in parallel. First to see the target launch tx wins.
//   5. Extract the newly-launched curve from the launch tx receipt.
//   6. For every buyer wallet: sign curve.buy(quoteIn, minTokensOut, buyer) in parallel, then
//      broadcast every signed tx to every RPC. Same-block landing for all wallets.
//
// Every buyer wallet MUST be on the pons snipe-exempt list at launch time — otherwise the buy
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
  candidateAddressesFromReceipt, candidatesFromSimulation,
  routedVia, encodeCurveBuyData, parseWalletSelection,
} from "./lib.mjs";

const CHAIN_ID = 4663;
const POLL_MS = 25;
const RECEIPT_POLL_MS = 20;
const RECEIPT_MAX_MS = 500;
const HEARTBEAT_MS = 1000;
const GAS_GWEI = 1n;
const GAS_WEI = GAS_GWEI * 1_000_000_000n;
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
`# Paste ONE buyer wallet private key per line (0x-prefixed 32-byte hex).
# Every wallet listed here will fire the same snipe in parallel — enables fanout distribution.
# EVERY listed wallet MUST be on the pons snipe-exempt list at launch time.
# Example (1 wallet):
# 0xabcdef...   (64 hex chars)
# Example (fanout across 3 wallets):
# 0xabcdef...
# 0x111222...
# 0x999888...
`, "pk.txt");

if (rpcsRaw === null || pkRaw === null) process.exit(1);

const rpcs = rpcsRaw
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
if (rpcs.length === 0) { console.error("✗ rpcs.txt has no HTTPS RPC URLs — add at least one and re-run."); process.exit(1); }
for (const u of rpcs) {
  if (!u.startsWith("https://")) { console.error(`✗ rpcs.txt: "${u}" is not https:// — HTTPS only.`); process.exit(1); }
}

const pkLines = pkRaw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
if (pkLines.length === 0) {
  console.error("✗ pk.txt: no private keys found. Add at least one 0x-prefixed 32-byte hex line."); process.exit(1);
}
for (let i = 0; i < pkLines.length; i++) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pkLines[i])) {
    console.error(`✗ pk.txt line ${i + 1}: "${pkLines[i].slice(0, 12)}…" is not a valid 0x-prefixed 32-byte hex private key.`); process.exit(1);
  }
}

// Build parallel wallet slots. Each slot: {account, address, nonce (cached)}.
const wallets = pkLines.map((pk) => {
  const account = privateKeyToAccount(pk);
  return { account, address: account.address.toLowerCase(), nonce: null };
});
// Detect and warn on duplicates — same key twice would collide on nonces.
const uniq = new Set(wallets.map((w) => w.address));
if (uniq.size !== wallets.length) {
  console.error("✗ pk.txt: duplicate private keys detected — every wallet must be distinct."); process.exit(1);
}

// ─── terminal prompts ───────────────────────────────────────────────────────
async function prompt() {
  const rl = readline.createInterface({ input, output });
  console.log("");
  console.log("pons v2 sniper — enter run parameters");
  console.log(`  rpcs          : ${rpcs.length} HTTPS`);
  console.log(`  gas           : ${GAS_GWEI} gwei (maxFee + priority both)`);
  console.log(`  poll          : ${POLL_MS} ms`);
  console.log("");
  console.log("buyer wallets loaded from pk.txt:");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const bal = w.balWei != null ? `${formatEther(w.balWei)} ETH` : "?";
    console.log(`  [${i + 1}] ${w.address}  bal=${bal}`);
  }
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

  // Which wallets to use?
  const selection = await ask(
    wallets.length === 1
      ? "which wallets? [Enter for '1']: "
      : `which wallets to buy from? (e.g. 1,3 or 1-3 or 'all'): `,
    (s) => {
      if (!s && wallets.length === 1) return { ok: true, value: new Set([1]) };
      const r = parseWalletSelection(s, wallets.length);
      return r.ok ? { ok: true, value: r.value } : { ok: false, err: r.err };
    }
  );
  const selectedIdx = Array.from(selection).sort((a, b) => a - b);

  // Same amount for all, or per-wallet?
  let mode = "same";
  if (selectedIdx.length > 1) {
    mode = await ask("buy amount — same for all selected, or per wallet? [same/per]: ", (s) => {
      const t = s.toLowerCase();
      if (!t || t === "same" || t === "s") return { ok: true, value: "same" };
      if (t === "per" || t === "p") return { ok: true, value: "per" };
      return { ok: false, err: "type 'same' or 'per'" };
    });
  }

  const amountsEth = new Map(); // 1-based idx -> string ETH
  if (mode === "same") {
    const a = await ask(`buy amount in ETH (applied to ${selectedIdx.length} wallet${selectedIdx.length > 1 ? "s" : ""}): `, (s) => {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, err: "must be a positive number" };
      return { ok: true, value: s };
    });
    for (const i of selectedIdx) amountsEth.set(i, a);
  } else {
    for (const i of selectedIdx) {
      const w = wallets[i - 1];
      const a = await ask(`  wallet #${i} ${w.address} — buy amount (ETH): `, (s) => {
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, err: "must be a positive number" };
        return { ok: true, value: s };
      });
      amountsEth.set(i, a);
    }
  }

  const slippagePct = await ask("slippage % (e.g. 5): ", (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, err: "must be a number in [0, 100]" };
    return { ok: true, value: n };
  });

  rl.close();
  return { dev, selectedIdx, amountsEth, slippagePct };
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

// ─── detection ──────────────────────────────────────────────────────────────
let devWallet = null;
let slippageBps = 0;
let fired = false;
// Filled after prompt: subset of `wallets` chosen by the user, each with .buyAmountWei set.
let activeWallets = [];
const seenTxs = new Set();
const factoryLower = PONS_FACTORY.toLowerCase();

const isTargetLaunch = (tx) => isTargetLaunchLib(tx, devWallet);
const isCanonicalLaunchSelector = (tx) => isCanonicalLaunchSelectorLib(tx);

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

async function findLaunchedCurveFromPendingTx(client, tx) {
  try {
    const raw = await client.request({
      method: "eth_call",
      params: [{
        from: tx.from, to: tx.to, data: tx.input, value: tx.value,
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
  } catch { /* eth_call reverted or unsupported */ }
  return null;
}

// ─── fire (multi-wallet fanout, per-wallet buy amounts) ─────────────────────
async function fire(curveAddr, sourceHash) {
  if (fired) return;
  fired = true;

  const client = httpClients[0];
  const tFire = Date.now();
  const minOut = 0n; // speed-first: slippage off, exempt wallets don't need it
  const gasLimit = 500000n;
  const maxGasCost = gasLimit * GAS_WEI;
  const totalSpend = activeWallets.reduce((sum, w) => sum + w.buyAmountWei, 0n);

  log(`── LAUNCH DETECTED ──`);
  log(`  source tx    : ${sourceHash}`);
  log(`  curve        : ${curveAddr}`);
  log(`  wallets      : ${activeWallets.length} selected`);
  log(`  total spend  : ${formatEther(totalSpend)} ETH`);
  log(`  gas          : ${GAS_GWEI}/${GAS_GWEI} gwei`);

  // Pre-flight: check every active wallet has funds for ITS OWN buy amount.
  const balances = await Promise.all(activeWallets.map((w) =>
    client.getBalance({ address: w.address }).catch(() => null)
  ));
  const eligible = [];
  for (let i = 0; i < activeWallets.length; i++) {
    const w = activeWallets[i];
    const need = w.buyAmountWei + maxGasCost;
    const bal = balances[i];
    if (bal === null) { warn(`  ${w.address}: balance check failed — including anyway`); eligible.push(w); continue; }
    if (bal < need) {
      err(`  ${w.address}: SKIPPED — have ${formatEther(bal)} ETH, need ${formatEther(need)} ETH (${formatEther(w.buyAmountWei)} buy + ${formatEther(maxGasCost)} gas)`);
      continue;
    }
    eligible.push(w);
  }
  if (eligible.length === 0) {
    err(`no wallet has sufficient balance — nothing to fire`);
    fired = false; return;
  }
  log(`  eligible     : ${eligible.length}/${activeWallets.length} wallets have funds`);

  // Sign all eligible wallets in parallel. Each uses its own cached nonce + own buy amount.
  const signPromises = eligible.map(async (w) => {
    const nonce = w.nonce;
    w.nonce = nonce + 1;
    try {
      const request = {
        to: curveAddr,
        data: encodeCurveBuyData(w.buyAmountWei, minOut, w.address),
        value: w.buyAmountWei,
        gas: gasLimit,
        maxFeePerGas: GAS_WEI,
        maxPriorityFeePerGas: GAS_WEI,
        nonce,
        chainId: CHAIN_ID,
        type: "eip1559",
      };
      const signed = await w.account.signTransaction(request);
      return { wallet: w, nonce, signed, err: null };
    } catch (e) {
      w.nonce = nonce; // roll back cached nonce so we can retry the slot
      return { wallet: w, nonce, signed: null, err: e.shortMessage || e.message };
    }
  });
  const signResults = await Promise.all(signPromises);
  const signed = signResults.filter((r) => r.signed);
  if (signed.length === 0) {
    err(`all wallets failed to sign: ${signResults.map((r) => r.err).join(" | ")}`);
    for (const r of signResults) r.wallet.nonce = r.nonce; // roll back
    fired = false; return;
  }
  log(`  signed       : ${signed.length}/${eligible.length} txs in ${Date.now() - tFire}ms`);

  // Broadcast each signed tx to every RPC in parallel. That's N wallets × M RPCs total requests.
  const broadcasts = [];
  for (const r of signed) {
    for (let i = 0; i < httpClients.length; i++) {
      broadcasts.push(
        httpClients[i].request({ method: "eth_sendRawTransaction", params: [r.signed] })
          .then((h) => ({ wallet: r.wallet, nonce: r.nonce, rpc: i, ok: true, hash: h }))
          .catch((e) => ({ wallet: r.wallet, nonce: r.nonce, rpc: i, ok: false, err: e.shortMessage || e.message }))
      );
    }
  }
  const bcResults = await Promise.all(broadcasts);

  // Per-wallet outcome — a wallet succeeded if AT LEAST ONE RPC accepted its tx.
  const perWalletHash = new Map();
  const perWalletErr = new Map();
  for (const r of bcResults) {
    if (r.ok && !perWalletHash.has(r.wallet.address)) perWalletHash.set(r.wallet.address, r.hash);
    if (!r.ok) {
      const prev = perWalletErr.get(r.wallet.address) || [];
      prev.push(r.err);
      perWalletErr.set(r.wallet.address, prev);
    }
  }

  // Roll back nonces for wallets that never got accepted anywhere.
  for (const r of signed) {
    if (!perWalletHash.has(r.wallet.address)) {
      r.wallet.nonce = r.nonce; // slot never consumed
      err(`  ${r.wallet.address}: all RPCs rejected — ${(perWalletErr.get(r.wallet.address) || []).slice(0, 1).join(" | ")}`);
    }
  }

  const broadcastMs = Date.now() - tFire;
  if (perWalletHash.size === 0) {
    err(`no wallet made it on-chain — all broadcasts rejected. Cache reset for retry.`);
    fired = false; return;
  }
  ok(`${perWalletHash.size}/${signed.length} wallets broadcast in ${broadcastMs}ms`);
  for (const [addr, hash] of perWalletHash) log(`    ${addr}  →  ${hash}`);

  // Wait for confirmations in parallel — report each wallet's success/failure independently.
  const confirmations = Array.from(perWalletHash.entries()).map(async ([addr, hash]) => {
    const t0 = Date.now();
    try {
      const receipt = await client.waitForTransactionReceipt({ hash });
      const dt = Date.now() - t0;
      if (receipt.status === "success") ok(`  ${addr}: confirmed ${dt}ms (block ${receipt.blockNumber})`);
      else err(`  ${addr}: reverted on-chain (${hash})`);
    } catch (e) {
      err(`  ${addr}: wait failed: ${e.shortMessage || e.message}`);
    }
  });
  await Promise.all(confirmations);
  log(`total fire→confirmed: ${Date.now() - tFire}ms`);
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
      warn(`could not resolve curve from ${tx.hash} — retrying via next scan`);
      seenTxs.delete(tx.hash);
      continue;
    }
    await fire(found.curve, tx.hash);
    return;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  // Prime balances + nonces for ALL loaded wallets BEFORE the prompt so the picker
  // can show each wallet's balance next to its address.
  await Promise.all(wallets.map(async (w) => {
    try {
      const [bal, n] = await Promise.all([
        httpClients[0].getBalance({ address: w.address }),
        httpClients[0].getTransactionCount({ address: w.address, blockTag: "pending" }),
      ]);
      w.balWei = bal;
      w.nonce = n;
    } catch (e) { warn(`  ${w.address}: prime failed: ${e.shortMessage || e.message}`); }
  }));

  const { dev, selectedIdx, amountsEth, slippagePct } = await prompt();
  devWallet = dev;
  slippageBps = Math.round(slippagePct * 100);

  // Bind chosen wallets + their per-wallet buy amounts.
  activeWallets = selectedIdx.map((i) => {
    const w = wallets[i - 1];
    w.buyAmountWei = parseEther(amountsEth.get(i));
    return w;
  });

  console.log("");
  log(`monitoring dev  : ${devWallet}`);
  log(`active wallets  : ${activeWallets.length}/${wallets.length}`);
  for (const w of activeWallets) {
    log(`  ${w.address}  buy=${formatEther(w.buyAmountWei)} ETH  bal=${w.balWei != null ? formatEther(w.balWei) : "?"} ETH  nonce=${w.nonce}`);
  }
  log(`slippage        : ${slippagePct}%  (${slippageBps} bps)`);

  // Warm HTTP/1.1 to every RPC to skip TCP+TLS handshake on the fire path.
  await Promise.all(httpClients.map((c) => c.getBlockNumber().catch(() => null)));
  log(`warmed          : ${httpClients.length} HTTPS connections`);

  // RPC capability probe: txpool_contentFrom vs nonce-jump fallback.
  const stats = httpClients.map(() => ({
    pollN: 0, jumpN: 0, errN: 0, lastNonce: -1, lastErr: "",
    method: "probing",
  }));

  async function probeTxpool(client) {
    try {
      await client.transport.request({ method: "txpool_contentFrom", params: [devWallet] });
      return true;
    } catch { return false; }
  }
  await Promise.all(httpClients.map(async (client, i) => {
    const has = await probeTxpool(client);
    stats[i].method = has ? "txpool" : "nonce";
  }));
  ok(`RPC capability probe: ${stats.map((s, i) => `${new URL(rpcs[i]).host} → ${s.method}`).join(", ")}`);

  await Promise.all(httpClients.map(async (client, i) => {
    try {
      stats[i].lastNonce = await client.getTransactionCount({ address: devWallet, blockTag: "pending" });
    } catch (e) { stats[i].errN++; stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80); }
  }));
  log(`baseline pending nonce for ${devWallet}: ${stats[0].lastNonce}`);

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
          log(`(${label}) dev tx in ${tag}: to=${tx.to} sel=${sel} hash=${tx.hash}`);
          if (!LAUNCH_TARGETS.has(to)) { seenTxs.add(tx.hash); continue; }
          sawAnyToLaunchTarget = true;
          const via = routedVia(to);
          if (to === factoryLower && !isCanonicalLaunchSelector(tx)) {
            log(`(${label}) ↳ selector ${sel} isn't the known launchToken selector (${PONS_LAUNCH_SELECTOR}) — chasing anyway`);
          }
          seenTxs.add(tx.hash);
          log(`(${label}) ✔ dev→${via} tx: ${tx.hash} — resolving curve…`);

          const t0 = Date.now();
          let found = null;
          if (tag === "pending") {
            found = await findLaunchedCurveFromPendingTx(client, tx).catch(() => null);
            if (found) log(`  curve resolved in ${Date.now() - t0}ms (pending-tx simulation)`);
          }
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
      warn(`(${label}) nonce jumped but dev's tx wasn't in pending or the last 10 blocks — RPC lagging. Rolling back.`);
      stats[i].lastNonce = oldN;
    } else if (!sawAnyToLaunchTarget) {
      warn(`(${label}) dev's tx wasn't to factory OR forwarder — not a launch.`);
    }
  }

  httpClients.forEach((client, i) => {
    const label = `rpc#${i}(${stats[i].method})`;
    setInterval(async () => {
      if (stats[i].method === "txpool") { await pollTxpool(client, i, label); return; }
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

  ok(`watching wallet ${devWallet} across ${httpClients.length} HTTPS RPCs @ ${POLL_MS}ms  ·  ${activeWallets.length} active buyer wallet${activeWallets.length > 1 ? "s (fanout)" : ""}`);

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
