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
const CHAIN_ID = 4663;
const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const PONS_LAUNCH_SELECTOR = "0xa72101af";
const POLL_MS = 100;
const GAS_GWEI = 1n;
const GAS_WEI = GAS_GWEI * 1_000_000_000n; // maxFee + priority both = 1 gwei
const ZERO = "0x0000000000000000000000000000000000000000";
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
const seenTxs = new Set(); // dedupe across all RPCs
const factoryLower = PONS_FACTORY.toLowerCase();

function isTargetLaunch(tx) {
  if (!tx || !tx.hash || !tx.to || !tx.input) return false;
  if (tx.to.toLowerCase() !== factoryLower) return false;
  if ((tx.from || "").toLowerCase() !== devWallet) return false;
  return tx.input.slice(0, 10).toLowerCase() === PONS_LAUNCH_SELECTOR;
}

// Extract the launched curve from a launch-tx receipt: scan every factory log's topics + data
// words for 20-byte address candidates, then call `.curve()` on each — the one that answers wins.
async function findLaunchedCurve(client, txHash) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== "success") return null;

  const seen = new Set();
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== factoryLower) continue;
    for (const t of l.topics) {
      if (typeof t === "string" && t.length === 66) {
        seen.add("0x" + t.slice(-40).toLowerCase());
      }
    }
    if (l.data && l.data.length > 2) {
      const d = l.data.slice(2);
      for (let i = 24; i + 40 <= d.length; i += 64) {
        seen.add("0x" + d.slice(i, i + 40).toLowerCase());
      }
    }
  }
  seen.delete(ZERO);

  for (const candidate of seen) {
    try {
      const curve = await client.readContract({
        address: candidate, abi: TOKEN_ABI, functionName: "curve",
      });
      if (curve && curve !== ZERO) return { token: candidate, curve: curve.toLowerCase() };
    } catch { /* not a pons token */ }
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
  log(`── LAUNCH DETECTED ──`);
  log(`  source tx    : ${sourceHash}`);
  log(`  curve        : ${curveAddr}`);
  log(`  buyer        : ${buyer}`);
  log(`  spend        : ${formatEther(buyAmountWei)} ETH`);
  log(`  gas          : ${GAS_GWEI}/${GAS_GWEI} gwei`);

  const minOut = await computeMinTokensOut(client, curveAddr);
  const args = [buyAmountWei, minOut, buyer];

  // Gas limit: try estimate, fall back to 400k.
  let gasLimit;
  try {
    gasLimit = await client.estimateContractGas({
      address: curveAddr, abi: CURVE_BUY_ABI, functionName: "buy",
      args, value: buyAmountWei, account,
    });
    gasLimit = (gasLimit * 130n) / 100n;
  } catch (e) {
    warn(`gas estimate failed (${e.shortMessage || e.message}); using 400000`);
    gasLimit = 400000n;
  }
  log(`  gasLimit     : ${gasLimit}`);

  try {
    const hash = await walletClient.writeContract({
      address: curveAddr, abi: CURVE_BUY_ABI, functionName: "buy",
      args, value: buyAmountWei, gas: gasLimit,
      maxFeePerGas: GAS_WEI, maxPriorityFeePerGas: GAS_WEI,
    });
    ok(`buy tx sent: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") ok(`buy CONFIRMED in block ${receipt.blockNumber}`);
    else err(`buy FAILED on-chain: ${hash}`);
  } catch (e) {
    err(`buy broadcast failed: ${e.shortMessage || e.message}`);
    fired = false; // let another detection retry
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

  // Sanity: buyer balance check
  try {
    const bal = await httpClients[0].getBalance({ address: buyer });
    log(`buyer balance   : ${formatEther(bal)} ETH`);
    if (bal < buyAmountWei) warn("buyer balance is below buy amount — top up before the launch fires");
  } catch { /* silent */ }

  // Wallet-centric watcher. Every 100ms per RPC:
  //   1. eth_getTransactionCount(dev, "pending")   — cheap 1-word call
  //   2. When the pending nonce JUMPS, dev just sent a tx. Immediately scan the pending mempool
  //      block AND the latest confirmed block for a tx whose from == dev AND selector matches.
  //   3. If found and it's a launch, fire.
  //
  // Watching the wallet's nonce is orders of magnitude cheaper than fetching every block's full
  // tx list — and hitting the pending block means we can see the launch tx BEFORE it's mined.
  const stats = httpClients.map(() => ({ pollN: 0, jumpN: 0, errN: 0, lastNonce: -1, lastErr: "" }));

  // Prime each RPC's baseline nonce.
  await Promise.all(httpClients.map(async (client, i) => {
    try {
      stats[i].lastNonce = await client.getTransactionCount({ address: devWallet, blockTag: "pending" });
    } catch (e) { stats[i].errN++; stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80); }
  }));
  log(`baseline pending nonce for ${devWallet}: ${stats[0].lastNonce}`);

  async function onNonceJump(client, i, oldN, newN, label) {
    log(`(${label}) nonce jump ${oldN} → ${newN} — dev sent ${newN - oldN} tx, hunting launch call…`);
    // Try pending block first (unmined mempool). Then latest confirmed. Whichever finds it wins.
    for (const tag of ["pending", "latest"]) {
      try {
        const block = await client.getBlock({ blockTag: tag, includeTransactions: true });
        for (const tx of block.transactions || []) {
          if (typeof tx === "string") continue;
          if (seenTxs.has(tx.hash)) continue;
          if (!isTargetLaunch(tx)) continue;
          seenTxs.add(tx.hash);
          log(`(${label}) ✔ launch tx in ${tag} block: ${tx.hash}`);

          // If the tx is still pending, we need to wait for the receipt. Give it a 6s window.
          let found = null;
          for (let attempt = 0; attempt < 60 && !found; attempt++) {
            found = await findLaunchedCurve(client, tx.hash).catch(() => null);
            if (!found) await new Promise((r) => setTimeout(r, 100));
          }
          if (!found) { warn(`could not resolve curve for ${tx.hash} — timed out waiting for receipt`); continue; }
          await fire(found.curve, tx.hash);
          return;
        }
      } catch (e) {
        // pending block may not be supported by every RPC — that's fine, try next tag
        stats[i].errN++;
        stats[i].lastErr = (e.shortMessage || e.message || "").slice(0, 80);
      }
    }
  }

  httpClients.forEach((client, i) => {
    const label = `rpc#${i}`;
    setInterval(async () => {
      stats[i].pollN++;
      try {
        const nonce = await client.getTransactionCount({ address: devWallet, blockTag: "pending" });
        if (nonce > stats[i].lastNonce) {
          const old = stats[i].lastNonce;
          stats[i].lastNonce = nonce;
          stats[i].jumpN++;
          onNonceJump(client, i, old, nonce, label); // fire and forget
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
      return `  ${url.padEnd(40)}  polls=${st.pollN}  jumps=${st.jumpN}  nonce=${st.lastNonce}${errTail}`;
    }).join("\n");
    log(`— heartbeat —\n${lines}`);
  }, 5000);
}

main().catch((e) => { err(String(e.stack || e)); process.exit(1); });
