# Koincity recovery

Live site (no install): https://bawcejawn.github.io/Koincity-stake-pools/

Open that page and connect Kondor. Nothing else is required.

Local page for Liquidity UP staking pools and token locks on Koinos mainnet. It reads the Koincity staking contract and the Koincity token-lock contract. Claim, unstake, and release are sent only after you approve them.

## Run

From this folder:

```
npm install
npm run dev
```

Open the `http://localhost:` address that command prints. Kondor must be installed in that browser if you use Connect Kondor.

## Wallets

Connect Kondor, or open a wallet in the tab with a WIF/hex private key or a seed phrase.

A key or seed stays in the tab. The page does not save it, does not put it in the address bar, and does not upload it. Use a computer only you control. Do not paste a key into chat, and do not let the browser save it.

A seed is turned into a key with SHA-256 of the exact text, which is the Koinos / Kondor method. If your wallet was not created that way, use the private key instead.

## What the page shows

The staking dropdown lists every pool id from `getStakes`. The lock dropdown lists every lock `getMyTokenLocks` returns for the connected address, including tokens other than Liquidity UP.

Token locks are ids inside `1FT1D2jLKeeEFcfG5Zo7WKfYNHH9MMeK5N`. Release calls `unlockTokenLock` for the full amount after the end time.

Reads use `https://api.koinosblocks.com` and `https://api.koinos.io`.
