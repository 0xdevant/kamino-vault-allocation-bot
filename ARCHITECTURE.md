# Architecture & design notes

Runtime deps:
`@kamino-finance/klend-sdk`, `@solana/kit`, `decimal.js`, `dotenv`, `zod`.

---

## 1. Defining the requirements

I understand "reallocate between 3 Kamino lending vaults to maximize yield" as:
**custody one wallet's capital and continuously move it between three Kamino
lending vaults to maximise net yield, subject to risk limits.**
I made the bot act as an ordinary depositor (public deposit/withdraw), not as
a vault curator — that keeps it demonstrable without involving the operational setup.

The decision I want to highlight: I treat vault _selection_ as a first-class
problem, separate from allocation. Picking which three vaults to even consider
is the highest-leverage risk decision — a perfect allocator over bad vaults
still loses money — so there's a dedicated **screener** that runs before any
capital moves (the screener stage, Step 0 in the decision flow).

**Scope: simulation-only by design.** The intellectual content of a yield bot
is choosing vaults, sizing positions, and exiting on time — all of which the
bot demonstrates against _real_ mainnet data. Every decision is validated
end-to-end via `simulateTransaction` (real Kamino SDK instructions, real
Solana RPC), so there is **no keypair involved in the codebase**.

---

## 2. The mental model

A poll loop does, every cycle: **read** the 3 pinned vaults from chain/REST →
run the **risk engine** against the rolling history → run the **allocator**
(which consumes the risk flags as per-vault caps) → diff the target vs. the
live position into an ordered **plan** → build the real Kamino SDK
instructions and **simulate** them against mainnet RPC (`simulateTransaction`,
`sigVerify:false` — no signing, ever) → append this cycle's snapshot to
history for the next tick. Three stages — **screen / protect / allocate** —
and one hard architectural rule: the decision logic is **pure functions**,
all I/O lives in a thin shell around it.

---

## 3. Functional Core, Imperative Shell

The code is split along Gary Bernhardt's **Functional Core, Imperative Shell**
pattern:

- **Functional Core** — screener, allocator, risk evaluators. Plain functions
  over plain data: no network, disk, or clock. All money-affecting
  logic lives here.
- **Imperative Shell** — everything that touches the outside world: Kamino
  REST/SDK, the rolling history file, transaction simulation, the CLI.

```
              ┌─────────────────────────────────────────────────────┐
  IMPERATIVE  │  index.ts (CLI)  →  orchestrator.ts (loop)          │
  SHELL       │  data/ (RPC + REST + history file)                  │
  net/disk/   │  execution/ (build ixs + simulate)                  │
  terminal    └───────────────┬─────────────────────────────────────┘
                              │  plain data in  ▲  decisions out
              ┌───────────────▼─────────────────┴───────────────────┐
  FUNCTIONAL  │  screener/screenVaults   strategy/allocate          │
  CORE        │  risk/{aumCollapse, allocShift, maxUtilization,     │
  just math:  │        curatorAction classifier}                    │
  no net/disk └─────────────────────────────────────────────────────┘
```

[src/types.ts](src/types.ts) is the contract between the two halves: the Core
consumes/produces only those structs, the Shell fills them in and acts on
them. The split is what makes 32 deterministic offline tests possible — no
Solana background needed to follow the decision logic.

---

## 4. When to move capital between vaults (the core decision)

A switch happens only if it survives every gate below, ordered
**safety → opportunity → cost**.

**Step 0 — Eligibility (prerequisite, before the loop).** Only vaults that
pass the screener are candidates: minimum AUM, fee ceiling (perf + mgmt),
minimum APY, 90-day stability (today's APY can't be a transient spike far
above its 90d average), and an optional curator allowlist. Vault selection
is independent of and prior to allocation.

**Step 1 — Score each eligible vault on forward-looking yield.**
`score = wApy·netAPY + wUtil·utilisationTrend` (default 0.8 / 0.2).

- `netAPY` is after vault fees.
- `utilisationTrend` leads `netAPY`: a Kamino Earn vault's APY is the
  blended supply rate of its underlying Klend reserves, and a reserve's
  supply rate rises with borrow demand. Rising utilisation predicts a
  higher APY before it prints.

**Step 2 — Apply each vault's risk verdict as a cap.** The risk engine runs
before the allocator: `block` → cap 0 (exit if held), `warn` → reduced cap
(trim), clear → full `MAX_WEIGHT_PCT`. Risk can forbid a switch in and force
a switch out.

**Step 3 — Build the target (greedy waterfall under the cap).** Fill the
highest-scoring eligible vault up to its risk-adjusted cap, then the next.
Capital the caps can't absorb stays idle, not forced into a worse vault.

**Step 4 — Decide if the move is worth making.** Target ≠ current does not
by itself trigger a switch.

- **Safety-driven** (a held vault is now `warn`/`block` and over its
  tightened cap): switch immediately, bypassing every cost test.
- **Yield-driven**: must clear all three gates — APY gain ≥
  `IMPROVEMENT_THRESHOLD_BPS`, notional moved ≥ `MIN_MOVE_USD`, expected
  annual dollar gain > estimated one-off cost. Any one fails → HOLD.

---

## 5. Guardrail tradeoffs

- **Max-weight cap (default 40%)** trades a little yield for survivability:
  one vault failing (depeg, curator action, bad debt) loses at most that
  fraction. 40% lets three vaults fully deploy capital (40 + 40 + 20) without
  any single one being a majority.
- **Anti-churn hysteresis** trades responsiveness for net return.
  Rebalancing has costs (two transactions, share-price rounding); chasing
  every 5 bps wobble underperforms a do-nothing baseline. The three-part
  gate only acts when expected benefit beats known cost.
- **Safety overrides churn, not the reverse.** Risk exits ignore the cost
  gate entirely — principal loss and a few cents of fees aren't on the same
  scale.

---

## 6. Risk: graded, and honest about what's measurable

I graded severity on purpose, because the behaviour asked for was _"reduce
exposure"_, not always "run":

- `block` → vault weight forced to 0 (full exit).
- `warn` → vault capped at the reduced weight (trim, keep earning).
- `info` → logged only.

What's **exact** (read straight from chain/API): AUM level and its drop from
the rolling-window peak (`aum-collapse` — catches both sharp shocks and
sustained slow bleeds by comparing against the window peak, not the previous
sample), the curator‑controlled vault→reserve weight distribution
(`alloc-shift`), and AUM-weighted underlying reserve utilisation pinned at
≥ 99.9% across N consecutive polls (`max-utilization`).

**Curator-withdrawal detection — two complementary paths.** The kvault
program emits no Anchor events (no `events/` codegen, no `emit!`), so the
curator pulling liquidity is only observable as (a) the resulting state
change, or (b) the curator signing one of a small fixed instruction set:

- `curator-action` (**cause side**): polls `getSignaturesForAddress` for
  the vault's admin pubkeys (`vaultAdminAuthority` + `allocationAdmin`) and
  matches the 8-byte Anchor discriminators against the constants exported
  by the SDK codegen. `removeAllocation` / `updateAdmin` → `block`;
  `updateVaultConfig` → `warn`; `updateReserveAllocation` and keeper /
  fee ops → `info` (a re-weight is the curator's normal lever — drastic
  ones get caught state-side by `alloc-shift`). Seen-set is in-memory and bounded by
  `CURATOR_ACTION_LOOKBACK_MS`, so a restart can re-flag a very recent
  action once.
- `alloc-shift` (**state side, backstop**): a large swing in the
  curator-set allocation weights since the previous sample. Can't
  distinguish a malicious de-allocation from a benign rebalance, so it
  escalates only on extreme swings.
  - **Staleness guard.** History persists across restarts so delta signals
    aren't blinded on the first polls after one. But comparing today's
    weights against a baseline hours old turns a slow benign drift into a
    spurious "since last poll" swing — fixed in dry-run by skipping the
    delta when the prior sample is older than `maxSampleAgeMs` (5× the
    poll interval). The guard is scoped to cadence-sensitive signals
    (`alloc-shift`, util-trend); level signals (`aum-collapse`) stay valid
    across a gap.

**Why `max-utilization` is the exit-risk signal.** Per Kamino's curator
docs (_"a 100% utilised reserve has nothing to redeem"_), full utilisation
is the literal lockup condition. But a single full-utilisation reading
mean-reverts in stable-asset lending markets — a brief touch is normally a
yield-bullish spike that resolves next poll. The genuine stuck-reserve
scenario is _persistent_ pinning. The signal fires when AUM-weighted
utilisation stays ≥ 99.9% for `maxUtilPolls` consecutive samples
(`MAX_UTIL_SUSTAIN_MS` / `POLL_INTERVAL_MS`, default 5 min sustain), and
the window of samples must also span a plausibly poll-spaced duration so a
downtime gap can't fake "sustained". The more direct measure — the
explicit depositor withdrawal queue — isn't on Kamino's public read
surface (queue state lives in on-chain `WithdrawTicket` accounts; no SDK
helper). Activating that path is on the roadmap.

**Extension point.** External signals (news feed, real bad-debt feed)
implement the `RiskSignal` interface and slot into `signalsFor()` without
touching the engine. `curator-action` is the canonical example. Signals
that depend on data the bot can't honestly read today live on the roadmap,
not as fake numbers in the codebase.

---

## 7. Data flow of one cycle (the spine)

Entry: [src/orchestrator.ts](src/orchestrator.ts) `runOnce()`.

1. **`fetchVaultSnapshots()`** ([src/data/vaultData.ts](src/data/vaultData.ts))
   — for each pinned vault: `KaminoVault.getState()`, then
   `KaminoManager.getVaultTheoreticalAPY()` (returns `{grossAPY,netAPY}` —
   net is already fee-adjusted), `getVaultHoldings()` (AUM = available+invested),
   `getVaultAllocations()` (→ reserve target weights), and
   `loadVaultReserves()` reused by [data/utilization.ts](src/data/utilization.ts)
   to compute AUM-weighted reserve utilisation. REST
   ([data/restApi.ts](src/data/restApi.ts)) supplies `apy90d` and the vault
   `name`. Output: `VaultSnapshot[]` — the normalised view, APY in **percent**
   (converted once here via `cfg.apyIsFraction`).
2. **Portfolio seed** — first tick seeds a `Portfolio` of `SIM_IDLE_USD` idle
   cash + no positions. Subsequent ticks carry the paper-trade position via
   `state.sim` (see [`simulatePostTradePortfolio`](src/data/vaultData.ts)).
3. **`evaluateRisk()`** ([src/risk/index.ts](src/risk/index.ts)) — runs the 3
   built-in evaluators per vault against `history.forVault(id)`, then the
   pluggable signals (`curator-action`). Returns `RiskFlag[]`.
4. **`allocate()`** ([src/strategy/allocate.ts](src/strategy/allocate.ts)) —
   snapshots + portfolio + risk flags → `TargetAllocation` (weights + HOLD/
   REBALANCE + a human rationale per vault).
5. **`buildRebalancePlan()`** ([src/execution/plan.ts](src/execution/plan.ts))
   — diff target vs. current → ordered `RebalanceAction[]` (withdrawals first).
6. **`simulatePlan()`** ([src/execution/simulate.ts](src/execution/simulate.ts))
   — logs the concrete plan, builds the real SDK ixs, and runs
   `simulateTransaction` (`sigVerify:false`, placeholder fee-payer). Never signs.
7. **`history.append()` + `save()`** — persist this cycle's samples so the
   delta-based signals survive a restart.

`runLoop()` wraps this with a `setInterval`-free cancellable sleep, a per-cycle
`try/catch` (a 429 backs off 3×, never crashes the loop), SIGINT/SIGTERM clean
shutdown, and a slow-cadence `screenAdvisory()` that re-screens the available
vaults and _logs_ a better-vault suggestion — it never auto-swaps the pinned
set.

---

## 8. File-by-file

### Contract & infra

- **[src/types.ts](src/types.ts)** — every shared struct: `VaultSnapshot`,
  `Portfolio`, `ScreenResult`, `RiskFlag` (`severity: info|warn|block`),
  `RiskSignal` (the plugin interface), `HistorySample`, `TargetAllocation`,
  `RebalanceAction`, and the `*Config` slices. The FC/shell boundary.
- **[src/config.ts](src/config.ts)** — one zod schema → typed `Config`.
  Every var has a default, so an empty `.env` works; `loadConfig()`
  aggregates _all_ errors into one actionable message; cross-checks
  (e.g. `MAX_WEIGHT_PCT ≥ 100/N`). `UTIL_WEIGHT` is one knob → `wUtil`/`wApy`
  are derived to always sum to 1. `requirePinnedVaults` gates `run` (needs 3)
  vs `screen` (needs none).
- **[src/logger.ts](src/logger.ts)** — dependency-free leveled logger,
  `pretty` or `json`, Decimal/bigint-safe. Every decision is a structured
  event with a `reason`, so a run is auditable from logs alone.

### Functional Core — the decision logic

- **[src/screener/screenVaults.ts](src/screener/screenVaults.ts)** — STAGE 1.
  Hard filters (asset, AUM floor, fee ceiling, APY floor, **90d-stability** —
  rejects spikes, curator allowlist) → `eligible`. A transparent composite
  **score** = netAPY + capped AUM-robustness + stability bonuses
  (APY-percent-equivalent units; the `score-breakdown` criterion shows the
  sum). Sort = eligible-first, then score. Score and eligibility are
  _independent_ — a 38%-APY dust vault scores high but is still `✗`.
- **[src/strategy/allocate.ts](src/strategy/allocate.ts)** — STAGE 2.
  `score = wApy·netAPY + wUtil·utilTrend` (utilisation trend leads APY
  because reserve rates rise with borrow demand). Per-vault **cap** from risk
  severity: `block→0`, `warn→reducedW`, else `maxW`. **Greedy waterfall**
  fills the highest score up to its cap, then the next — concentrates yield
  under the diversification cap; unabsorbed capital becomes idle. Then
  **hysteresis**: negligible drift → HOLD; risk-forced → REBALANCE bypassing
  the gate (protecting capital isn't subject to "worth the gas?"); else
  require APY gain ≥ threshold _and_ move ≥ min _and_ gain > cost. Every
  branch emits a sentence used verbatim in the logs.
- **[src/risk/](src/risk/)** — STAGE 3, three pure evaluators
  `(snapshot, vaultHistory, cfg) → RiskFlag | null`:
  - `aumCollapse` — below absolute floor → block; drop from window peak
    > `aumDropPct` → warn, > 2× → block. Comparing against the window peak
    > (not the previous sample) catches both shocks and slow bleeds.
  - `allocShift` — total-variation of vault→reserve weights vs. last sample
    > `allocShiftPct` → warn (2× → block). State-side curator-pull backstop.
    > Skips the one catch-up cycle when the baseline is older than
    > `maxSampleAgeMs` so a downtime gap doesn't read as a phantom swing.
  - `maxUtilization` — AUM-weighted reserve utilisation ≥ `maxUtilPct` (99.9%)
    for `maxUtilPolls` consecutive samples → block. Sustained 100%, not a
    transient spike. Both a length AND a window-span guard, so a downtime
    gap can't fake "sustained."
- **[src/risk/index.ts](src/risk/index.ts)** — `evaluateRisk()` combinator
  (built-ins per vault + pluggable signals) and `worstSeverity()` for logging.
- **[src/risk/curatorAction.ts](src/risk/curatorAction.ts)** — pluggable,
  cause-side. `classifyKvaultDiscriminator()` is **pure** (unit-tested): it
  hex-matches the first 8 bytes of an instruction against the
  `DISCRIMINATOR` constants imported _straight from the SDK codegen_
  (`removeAllocation`/`updateAdmin`→block, re-weight/config→warn, keeper→info)
  — exact, upgrade-proof, no hardcoded bytes. The watcher polls
  `getSignaturesForAddress` for the admin pubkeys and attributes a matched
  instruction to a vault only if that vault is in the tx's accounts.
- The `RiskSignal` interface (in [src/types.ts](src/types.ts)) is the
  extension point: external signals (news feed, real bad-debt feed) implement
  it and slot into `signalsFor()` in the orchestrator without engine edits.
  `curatorAction` is the canonical example.

### Imperative Shell

- **[src/data/kaminoClient.ts](src/data/kaminoClient.ts)** — owns the
  `@solana/kit` RPC + `KaminoManager` + one `KaminoVault` per pinned address.
  No keypair plumbing (simulation-only).
- **[src/data/restApi.ts](src/data/restApi.ts)** — defensive typed client for
  `api.kamino.finance` (vault list, metrics/`apy90d`, `decodeVaultName`).
  Lenient parsing, `RateLimitError` for 429 backoff, never crashes on a shape
  change.
- **[src/data/utilization.ts](src/data/utilization.ts)** — AUM-weighted
  reserve utilisation from the SDK reserve map (reused, not re-fetched).
- **[src/data/history.ts](src/data/history.ts)** — bounded per-vault rolling
  buffer persisted to `data/history.json`; corrupt/missing file → start empty.
- **[src/data/vaultData.ts](src/data/vaultData.ts)** — the **assembler**: the
  only place that knows SDK object shapes. APY % normalisation, the
  staleness-guarded utilisation trend, and `fetchScreenCandidates()`
  (REST-first, bounded concurrency) for the screener.
- **[src/execution/plan.ts](src/execution/plan.ts)** — pure target→actions
  diff; withdrawals before deposits; sub-dollar deltas dropped.
- **[src/execution/buildIxs.ts](src/execution/buildIxs.ts)** — one action →
  ordered SDK instructions (unstake→withdraw→post; deposit→stake — skipping
  farm ixs would strand funds).
- **[src/execution/tx.ts](src/execution/tx.ts)** — kit plumbing:
  `simulateInstructions` (fee-payer address only, `sigVerify:false`, no key).
- **[src/execution/simulate.ts](src/execution/simulate.ts)** — always prints
  the concrete plan; if a fee-payer address is set, builds the _real_ SDK ixs
  and runs `simulateTransaction`. Never signs (no signing path exists).
- **[src/orchestrator.ts](src/orchestrator.ts)** — wires the spine: `runOnce`,
  `runLoop`, `runOnceCli`, `runScreenCli` (the aligned screen table), and
  `signalsFor()` assembling the pluggable signal set.
- **[src/index.ts](src/index.ts)** — CLI. Parses `screen | run` + `--once`,
  prints the bold `MODE: SIMULATION-ONLY` banner + redacted effective config,
  dispatches.

---

## 9. Safety model (worth knowing cold)

- **No signing path exists.** Funds-at-risk is impossible by construction, not
  by configuration — there is no keypair handling and no broadcast code in
  the repo. Going live in production is a one-file addition (see the README
  roadmap).
- **Risk is graded:** `block` → weight 0 (full exit), `warn` → reduced cap
  (trim, keep earning), `info` → logged only.
- **Safety bypasses anti-churn.** A held vault that just got flagged is exited/
  trimmed even if the move is "not worth the gas" — capital protection is not
  cost-gated. Yield moves _are_ cost-gated (the hysteresis triple test).
- **Diversification cap** bounds single-vault blow-up by construction; if every
  vault is blocked, capital sits as idle cash rather than being forced anywhere.

---

## 10. Testing strategy

`npm test` (vitest, 32 tests, **offline & deterministic** — no network):
`screenVaults` (filters/score/stability/ranking), `allocate` (cap, waterfall,
hysteresis, risk-forced bypass, idle parking), the 3 risk evaluators (trip/
no-trip incl. the 95%-utilisation calibration and staleness guards),
`simulatePostTradePortfolio` (paper-trade convergence), and
`classifyKvaultDiscriminator` (pins every SDK discriminator + severity, so an
SDK upgrade that changes them fails CI loudly). The Imperative Shell is
validated by the documented manual gates: `npm run typecheck`, the read-only
`screen`, and the `--once` simulate.

---

## 11. Known limitations

- **Asset price.** AUM/liquidity use the API's USD figures (accurate). Deposit
  sizing uses `ASSET_PRICE_USD` (1 for stables); a non‑stable underlying should
  wire an oracle.
- **Single asset.** APY is only comparable between same‑asset vaults, so the
  bot operates within one asset (default USDC). Multi‑asset would need an
  FX/risk model.
- **Curator reputation.** Proxied by an allowlist + underlying-reserve
  health; no first-class on-chain metric exists.
- **No live execution.** The bot does not sign or broadcast. The simulation
  path validates the SDK boundary end-to-end; live broadcast is a one-file
  addition on top.

---

## 12. Trace a real run in 6 lines of log

`vault.status` (normalised snapshot) → `risk.flag` (any breaker + reason) →
`allocator.decision` (HOLD/REBALANCE + summary) → `allocator.target`
(per-vault weight + rationale) → `execute.action` (concrete withdraw/
deposit) → `execute.simulated` (RPC sim result). Each line carries a
`reason` field.
