# pons v2 launch sniper

Multi-wallet direct sniper for pons v2 launches on Robinhood chain. Watches a dev wallet across multiple HTTPS RPCs at 25ms poll cadence. When it lands a `launchToken` tx on pons's real v2 factory (`0x7eD598…`) or launchForwarder (`0xe33E9E…`), extracts the curve address from the receipt and immediately fires `curve.buy(quoteIn, minTokensOut, buyer)` from **every buyer wallet in `pk.txt`** simultaneously (fanout snipe).

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
- **`pk.txt`** — one buyer wallet private key per line (0x-prefixed 32-byte hex). **List multiple keys to fan out the snipe across multiple wallets in parallel** (each wallet fires the same buy amount independently). Comments with `#`.

Fill both, then re-run. The script will then prompt you in the terminal for:

- **dev wallet to monitor** — the wallet whose `launchToken` tx will trigger the buy
- **buy amount in ETH per wallet** — `msg.value` of each wallet's `curve.buy` call
- **slippage %** — currently a no-op inside `fire()` for speed; kept in the prompt for future use.

## Snipe-tax caveat

Every buyer wallet becomes `msg.sender` on its own `curve.buy` call. **Every listed address in `pk.txt` must be on the pons snipe-exempt list at launch time**, otherwise buys in the first 3 seconds pay ~99% snipe tax. Add each address to the exempt set when you launch.

## Fanout behavior

- Each key in `pk.txt` fires the buy amount **independently** (spend/wallet, not spend/total).
- Pre-flight balance check per wallet — under-funded wallets are skipped, the rest still fire.
- All wallets sign in parallel, then every signed tx is broadcast to every RPC in parallel (N × M requests total).
- Nonces are cached per wallet and incremented locally; rolled back on failure.
- All confirmations tracked independently; script exits after all wallets settle.

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
