# Kamino Lending Vault Allocation Bot

A TypeScript bot that **reallocates capital across Kamino Finance "Earn" lending
vaults to maximize yield — safely.** It screens the available vaults to pick the
ones worth using, splits capital across the chosen vaults by a yield signal
under a diversification cap, and runs an automatic **risk circuit‑breaker
engine** that trims or exits a vault before a problem costs money.

It is **simulation‑only**: it reads real mainnet data and _simulates_ every
transaction against the RPC, but never signs or sends. No keypair, no funds at
risk. Going live is a one-file addition — see the Roadmap below and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Quickstart

Requires Node ≥ 20.

```bash
npm install
cp .env.example .env          # every setting has a safe default
npm test                      # 32 offline unit tests — the decision logic
npm run screen                # rank the available USDC vaults (read-only)
```

Pick three addresses from the screen output, then dry‑run the allocator:

```bash
# PINNED_VAULTS + a pretend $100k of idle cash so there's something to allocate
PINNED_VAULTS=<a>,<b>,<c> SIM_IDLE_USD=100000 npm start
```

## What it does

```
                ┌───────────────────────────────────────────────┐
   npm run      │ STAGE 1  SCREENER  (REST only, no RPC)        │
   screen   ──▶ │ available vaults → same-asset → filter+rank   │ ──▶ you pin 3
                │ AUM · fees · APY-stability · curator          │
                └───────────────────────────────────────────────┘
                ┌───────────────────────────────────────────────┐
   npm start    │ STAGE 2  RISK ENGINE                          │
   (per poll)   │ aum-collapse · alloc-shift · max-utilization  │
                │ + pluggable: curator-action                   │
                │ → RiskFlag[] (block / warn / info severity)   │
                └───────────────────┬───────────────────────────┘
                ┌───────────────────▼───────────────────────────┐
   (per poll)   │ STAGE 3  ALLOCATOR  (pure)                    │
                │ score = wApy·netAPY + wUtil·utilTrend         │
                │ flags → cap: block→0, warn→reduced, else→maxW │
                │ greedy waterfall by score; unfilled → idle    │
                └───────────────────┬───────────────────────────┘
                ┌───────────────────▼───────────────────────────┐
   EXECUTOR     │ target vs current → withdraw/deposit actions  │
                │ build SDK ixs + simulateTransaction (no sign) │
                └───────────────────────────────────────────────┘
```

**Screening criteria** (Stage 1): minimum AUM, a fee ceiling (performance +
management bps), a minimum APY, an **APY‑stability** check (the rolling 90‑day
APY must be ≥ `STABILITY_FLOOR`× the current APY, so we don't chase a transient
spike), and an optional trusted‑curator allowlist. Each result carries a
human‑readable pass/fail reason and a transparent score breakdown.

**Risk engine (Stage 2):** graded `RiskFlag` evaluators that emit
`block` / `warn` / `info` severities per vault. The allocator (Stage 3) reads
the flags and applies the cap — the risk engine itself never modifies weights.
Safety‑driven moves bypass the anti‑churn hysteresis — protecting capital is
never subject to "is it worth the gas?". Built‑in signals:

| Signal            | Fires when                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aum-collapse`    | AUM below an absolute floor, or a large drop from the rolling-window peak (catches both sharp drops and sustained slow bleeds)                                                                             |
| `alloc-shift`     | the curator‑controlled vault→reserve weights swing sharply (state‑side backstop)                                                                                                                           |
| `curator-action`  | the curator/allocation admin signs a dangerous kvault instruction — `removeAllocation`/`updateAdmin` → block, `updateVaultConfig` → warn; `updateReserveAllocation` is logged as info (drastic shifts surface effect‑side via `alloc-shift`) (cause‑side, exact discriminator match) |
| `max-utilization` | the AUM-weighted underlying reserve utilisation sits ≥ 99.9% for N consecutive polls (default 5 min sustain) — block (a pinned reserve queues withdrawals, see Kamino docs)                                |

**Allocation (Stage 3):** consumes Stage 2's flags + the snapshots. The yield
signal blends net APY with the **utilisation trend** of the vault's underlying
Klend reserves — rising borrow demand pushes reserve rates up, so it's a
_leading_ indicator of APY. Capital is filled greedily into the best vaults;
each vault's cap is derived from its worst flag severity — `block → 0`,
`warn → RISK_REDUCED_MAX_WEIGHT_PCT`, else `MAX_WEIGHT_PCT` (default 40%).
Yield‑driven moves must clear an improvement threshold, a minimum notional,
and beat the estimated move cost (anti‑churn).

---

## Architecture & project layout

One principle drives the codebase: **Functional Core, Imperative Shell**

- **Functional Core** — the screener, allocator and risk evaluators are plain
  functions: same inputs → same output, _no_ network, disk, or clock.
  All money-affecting logic lives here, so it's covered by 32 deterministic
  offline tests and is readable without a Solana background.
- **Imperative Shell** — everything that touches the outside world (Kamino
  RPC/REST, the rolling history file, transaction simulation, the CLI). It
  just feeds the core clean data and acts on its decisions.

One poll cycle ([src/orchestrator.ts](src/orchestrator.ts) `runOnce`):
`fetch snapshots → risk engine → allocate → plan → simulate → record history`.
`src/types.ts` is the data contract between the two layers. (The _why_ behind
each choice is in [ARCHITECTURE.md](ARCHITECTURE.md).)

```
src/
  index.ts          CLI: args dispatch (screen | run [--once]), MODE banner
  orchestrator.ts   the poll loop wiring all stages together
  config.ts         env → validated typed Config (zod); every var defaulted
  logger.ts         structured, Decimal-safe leveled logger
  types.ts          shared types between Functional Core and Imperative Shell
  screener/         STAGE 1 — pure vault screener (screenVaults.ts)
  risk/             STAGE 2 — pure evaluators + pluggable signals + engine
                      pure:       aumCollapse, allocShift, maxUtilization
                      pluggable:  curatorAction (RiskSignal)
  strategy/         STAGE 3 — pure constrained allocator (allocate.ts)
  data/             Imperative Shell — fetch & persist
                      kaminoClient, restApi, vaultData, utilization, history
  execution/        Imperative Shell — plan → build SDK ixs → simulate
                      plan (pure), buildIxs, tx, simulate
test/               offline, deterministic — fixtures + 5 suites (32 tests)
```

## Example output (real mainnet data, dry-run)

`npm run screen` (abridged — live mainnet data):

```
Kamino Earn vault screen  ·  asset USDC  ·  40 screened  ·  8 eligible

  #    name                     score   netAPY   90dAPY        AUM     fee  curator      address
────────────────────────────────────────────────────────────────────────────────────────────────
  1  ✓ USDC Prime                8.46    8.32%    6.78%     $3.01M     0bp  JC8s…xgkt    9E69U4GzWhryRaPe8DYpco6Z9vTZY6gg8w6W2QsBACEj
  2  ✓ Steakhouse USDC           7.82    7.07%    6.98%    $32.13M   500bp  9ceR…xUjF    HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E
  9  ✗ usdc-stg                 37.50   37.91%    6.84%      $2.02     0bp  2oCD…mYaR    3UDmZki6bqjyXZuvniiR3pgjkZdhSeaeob8NjiovxgP7  · failed: aum, stability
```

(Note rank 9: the highest _score_ on the board — 37.91% APY — but `✗ rejected`
because it's a $2 dust vault and the APY is an unsustained spike. Safety gates
beat headline yield.)

## Configuration

**You can run with an empty `.env`.** Every setting has a safe default in
[src/config.ts](src/config.ts); `npm run screen` needs nothing, and `npm start`
needs only **`PINNED_VAULTS`**. `.env.example` shows the handful worth knowing
in an "essentials" block and an optional "tuning" block you can delete wholesale
— plus ~20 advanced knobs that stay out of the file (defaults in code). The
ones you're most likely to touch:

| Key                                               | Default          | Meaning                                                                             |
| ------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `PINNED_VAULTS`                                   | –                | the 3 vault addresses to allocate between (from `screen`) — _the only required one_ |
| `RPC_URL`                                         | public mainnet   | use a dedicated RPC in practice                                                     |
| `MAX_WEIGHT_PCT`                                  | 40               | per‑vault diversification cap                                                       |
| `UTIL_WEIGHT`                                     | 0.2              | yield signal: weight on utilisation trend (APY = the rest)                          |
| `MIN_AUM_USD` / `MAX_FEE_BPS` / `STABILITY_FLOOR` | 1e6 / 2000 / 0.7 | screen filters                                                                      |
| `MAX_UTIL_PCT` / `MAX_UTIL_SUSTAIN_MS`            | 99.9 / 300000    | `max-utilization` exit threshold + how long it must persist (ms) before blocking    |
| `SIM_IDLE_USD`                                    | 0                | pretend idle cash the paper‑trade allocator starts from                             |

## Production roadmap

The simulation path already validates the SDK boundary end-to-end (real
Kamino instructions, real RPC, real mainnet state). Production work an
operator would layer on top:

- **Live execution.** A signer-aware message builder +
  `sendAndConfirmTransactionFactory` against the operator's own keypair
- **News / Twitter signal.** A new `RiskSignal` implementation that turns
  incident feeds (webhook / Twitter) into graded `RiskFlag`s — added behind
  the existing `RiskSignal` interface, no engine edits needed.
- **Rewards / farm APY** in the yield signal, and a farm‑campaign‑end input
  to the screener — both require a per-reserve farm fetch that isn't wired yet.
- **Real klend liquidation feed** as a curator-reputation signal.

## Safety

The bot is **simulation‑only by design**. Every transaction the bot ever builds goes to `simulateTransaction` with `sigVerify:false` — the RPC executes the program logic against real mainnet state and returns the result, but no signature exists and no broadcast happens.

This is experimental software and is provided on an "as is" and "as available" basis.
