# pons v2 launch sniper

Single-wallet direct sniper for pons v2 launches on Robinhood chain. Watches N dev wallets across multiple HTTPS RPCs at 50ms poll cadence. When any of them lands a `launchToken` tx on pons's real v2 factory (`0x7eD598…`), extracts the curve address from the receipt and immediately fires `curve.buy(quoteIn, minTokensOut, buyer)` from your buyer wallet.

Gas is hardcoded at **1 gwei / 1 gwei** (maxFee + priority).

## Setup

```bash
git clone https://github.com/denil22/sniper.git
cd sniper
npm install
node sniper.mjs
```

On the first run, `sniper.mjs` will create two templates in the working directory if they're missing:

- **`rpcs.txt`** — one HTTPS RPC URL per line (comments with `#`)
- **`pk.txt`** — the buyer wallet's private key on a single line (0x-prefixed 32-byte hex)

Fill both, then re-run. The script will then prompt you in the terminal for:

- **dev wallet to monitor** — the wallet whose `launchToken` tx will trigger the buy
- **buy amount in ETH** — `msg.value` of the `curve.buy` call
- **slippage %** — computes `minTokensOut = expected × (1 − slippage/100)` via the curve's `previewBuy`. If the curve doesn't expose it, drops back to `minTokensOut = 0` with a warning.

## Snipe-tax caveat

Your buyer wallet becomes `msg.sender` on the `curve.buy` call. **That address must be on the pons snipe-exempt list at launch time**, otherwise buys in the first 3 seconds pay ~99% snipe tax. Add it via pons's frontend when you launch, or you're at the mercy of the 3-second decay.

## How detection works

For each new block seen on any HTTPS RPC:

1. Filter txs where `from == devWallet && to == ponsFactory && input[0:10] == 0xa72101af`.
2. Fetch the tx receipt.
3. Scan every log emitted by the pons factory. Extract every 20-byte address-shaped candidate from topics + data. Call `.curve()` on each — the one that answers is the token, its answer is the curve.
4. Optionally `previewBuy` on the curve to compute `minTokensOut` from your slippage.
5. Fire `curve.buy(quoteIn, minTokensOut, buyer)` from the primary RPC with `msg.value = quoteIn`, `maxFee = maxPriority = 1 gwei`.

All RPCs poll in parallel — first to spot the launch tx wins. Duplicates are deduped by tx hash.

## Exit behavior

Exits after ONE successful buy. Re-run for the next launch.
