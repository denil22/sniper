// Pure logic used by the sniper — extracted so the test suite can exercise it without any RPC.

export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
// pons's launchForwarder — their frontend routes launches through this contract, which then
// internally calls the factory. Verified on-chain from tx 0xac325885…
export const PONS_LAUNCH_FORWARDER = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948";
export const PONS_LAUNCH_SELECTOR = "0xa72101af"; // direct-factory launchToken sig
export const ZERO = "0x0000000000000000000000000000000000000000";

// Case-insensitive set of "any of these is a valid launch entrypoint".
export const LAUNCH_TARGETS = new Set([
  PONS_FACTORY.toLowerCase(),
  PONS_LAUNCH_FORWARDER.toLowerCase(),
]);

/**
 * A tx is a launch candidate iff:
 *   - from == devWallet (already lowercase)
 *   - to matches ONE OF the LAUNCH_TARGETS (factory OR forwarder)
 *
 * We deliberately do NOT filter by selector: pons could rev their factory, or the user could
 * route through a proxy. Anything from the dev to a watched target is chased.
 */
export function isTargetLaunch(tx, devWallet) {
  if (!tx || !tx.hash || !tx.to || !tx.input) return false;
  if (!LAUNCH_TARGETS.has(tx.to.toLowerCase())) return false;
  if ((tx.from || "").toLowerCase() !== devWallet) return false;
  return true;
}

/** True iff the tx's selector matches the canonical direct-factory launchToken sig. */
export function isCanonicalLaunchSelector(tx) {
  return (tx.input || "0x").slice(0, 10).toLowerCase() === PONS_LAUNCH_SELECTOR;
}

/**
 * Extract every address-shaped 20-byte candidate from a receipt's logs.
 * Scans: log.address, every 32-byte topic (low 20 bytes), every 32-byte word in log.data.
 * Removes the zero address, factory, forwarder, and dev — leaves the newly-created contracts.
 */
export function candidateAddressesFromReceipt(receipt, devWallet) {
  const seen = new Set();
  const factoryLower = PONS_FACTORY.toLowerCase();
  const forwarderLower = PONS_LAUNCH_FORWARDER.toLowerCase();
  for (const l of receipt.logs || []) {
    if (l.address) seen.add(l.address.toLowerCase());
    for (const t of l.topics || []) {
      if (typeof t === "string" && t.length === 66) {
        seen.add("0x" + t.slice(-40).toLowerCase());
      }
    }
    if (l.data && l.data.length > 2) {
      const d = l.data.slice(2);
      // 32-byte words; addresses live in the low 20 bytes (offset 24 of each 64-hex word).
      for (let i = 24; i + 40 <= d.length; i += 64) {
        seen.add("0x" + d.slice(i, i + 40).toLowerCase());
      }
    }
  }
  seen.delete(ZERO);
  seen.delete(factoryLower);
  seen.delete(forwarderLower);
  if (devWallet) seen.delete(devWallet.toLowerCase());
  return Array.from(seen);
}

/**
 * Extract candidates from an eth_call simulation's log output. Same logic as
 * candidateAddressesFromReceipt but the input is either a decoded logs array (from
 * debug_traceCall) or a raw hex return from eth_call (whose returned data may contain the
 * curve address as a return value — pons's launchToken returns (address token, address curve)).
 *
 * For pons's launchToken(...) → returns (address, address), the return data is 64 bytes:
 *   [0..32) = token address (padded)
 *   [32..64) = curve address (padded)
 *
 * We extract both and return them as strings for the caller to try. If the RPC returns logs
 * (via debug_traceCall/callTracer), we also process those.
 */
export function candidatesFromSimulation(returnData, logs, devWallet) {
  const out = new Set();
  // Pull addresses from return data if it looks like it contains any.
  if (typeof returnData === "string" && returnData.length >= 2) {
    const d = returnData.replace(/^0x/, "");
    for (let i = 24; i + 40 <= d.length; i += 64) {
      out.add("0x" + d.slice(i, i + 40).toLowerCase());
    }
  }
  // Also pull from logs if provided.
  if (Array.isArray(logs)) {
    for (const a of candidateAddressesFromReceipt({ logs }, devWallet)) {
      out.add(a);
    }
  }
  out.delete(ZERO);
  out.delete(PONS_FACTORY.toLowerCase());
  out.delete(PONS_LAUNCH_FORWARDER.toLowerCase());
  if (devWallet) out.delete(devWallet.toLowerCase());
  return Array.from(out);
}

/** Format labels for which entrypoint routed a tx. */
export function routedVia(toAddress) {
  const to = (toAddress || "").toLowerCase();
  if (to === PONS_FACTORY.toLowerCase()) return "factory";
  if (to === PONS_LAUNCH_FORWARDER.toLowerCase()) return "forwarder";
  return "unknown";
}

/** Local calldata encoder for curve.buy(uint256, uint256, address) — bypasses viem's ABI encoder. */
export function encodeCurveBuyData(quoteIn, minTokensOut, recipient) {
  const sel = "0x59a87bc1"; // pons v2 canonical buy selector — verified on-chain
  const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
  const qIn = pad(quoteIn.toString(16));
  const mIn = pad(minTokensOut.toString(16));
  const rec = pad(recipient.slice(2).toLowerCase());
  return sel + qIn + mIn + rec;
}
