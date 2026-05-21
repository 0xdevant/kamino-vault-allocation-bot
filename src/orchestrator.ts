import { Decimal } from 'decimal.js';
import { applyHotReload, reloadConfig, requirePinnedVaults, type Config } from './config.js';
import type { Logger } from './logger.js';
import { History } from './data/history.js';
import { KaminoClient } from './data/kaminoClient.js';
import { KaminoRestApi, RateLimitError } from './data/restApi.js';
import {
  fetchScreenCandidates,
  fetchVaultSnapshots,
  simulatePostTradePortfolio,
  toHistorySample,
} from './data/vaultData.js';
import { screenVaults } from './screener/screenVaults.js';
import { evaluateRisk, worstSeverity } from './risk/index.js';
import { makeCuratorActionSignal } from './risk/curatorAction.js';
import { allocate } from './strategy/allocate.js';
import { buildRebalancePlan } from './execution/plan.js';
import { simulatePlan } from './execution/simulate.js';
import type { Portfolio, RiskFlag, RiskSignal } from './types.js';

// Signals carry in-memory state across ticks, so build once and reuse.
function signalsFor(cfg: Config, client: KaminoClient): RiskSignal[] {
  return [
    makeCuratorActionSignal({ rpc: client.rpc, lookbackMs: cfg.curatorActionLookbackMs }),
  ];
}

// Per-tx signature when present (curator-action); else severity so warn→block re-logs.
function flagKey(flag: RiskFlag): string {
  const uniq = flag.metric?.signature ?? flag.severity;
  return `${flag.vaultId}|${flag.signal}|${uniq}`;
}

export interface LoopState {
  sim?: Portfolio;
  loggedFlags: Map<string, RiskFlag>;
}

/**
 * One decision cycle. Seeds from `SIM_IDLE_USD` on the first tick and carries
 * the paper-trade position via `state.sim` thereafter so the loop converges to HOLD.
 */
export async function runOnce(
  client: KaminoClient,
  rest: KaminoRestApi,
  history: History,
  cfg: Config,
  log: Logger,
  signals: RiskSignal[],
  state: LoopState,
): Promise<void> {
  const snapshots = await fetchVaultSnapshots(client, rest, history, cfg, log);
  const isSeed = state.sim === undefined;
  const idle = new Decimal(cfg.simIdleUsd);
  const portfolio: Portfolio =
    state.sim ?? { byVault: [], idleUsd: idle, totalUsd: idle };
  const riskFlags = await evaluateRisk(snapshots, history, cfg.risk, signals);

  for (const snap of snapshots) {
    log.info('vault.status', {
      vault: snap.id,
      name: snap.name || '(unnamed)',
      netApy: `${snap.netApy.toDecimalPlaces(2)}%`,
      apy90d: `${snap.apy90d.toDecimalPlaces(2)}%`,
      aumUsd: snap.aumUsd.toDecimalPlaces(0).toString(),
      util: `${snap.weightedUtilization.mul(100).toDecimalPlaces(1)}%`,
      utilTrend: `${snap.utilizationTrend.mul(100).toDecimalPlaces(2)}pp`,
      risk: worstSeverity(snap.id, riskFlags),
    });
  }
  // Log only on transition: new flag at its severity, cleared flag at info.
  const currentKeys = new Set<string>();
  for (const flag of riskFlags) {
    const key = flagKey(flag);
    currentKeys.add(key);
    if (state.loggedFlags.has(key)) continue;
    const at = flag.severity === 'block' ? 'error' : flag.severity === 'warn' ? 'warn' : 'info';
    log[at]('risk.flag', { vault: flag.vaultId, signal: flag.signal, severity: flag.severity, reason: flag.reason });
    state.loggedFlags.set(key, flag);
  }
  for (const [key, prev] of state.loggedFlags) {
    if (currentKeys.has(key)) continue;
    log.info('risk.flag.cleared', { vault: prev.vaultId, signal: prev.signal, prevSeverity: prev.severity });
    state.loggedFlags.delete(key);
  }

  log.info('portfolio', {
    source: isSeed ? 'simulated seed' : 'simulated (paper-trade)',
    totalUsd: portfolio.totalUsd.toDecimalPlaces(0).toString(),
    held: portfolio.byVault.map((pos) => `${pos.vaultId}=$${pos.valueUsd.toDecimalPlaces(0)}`),
    idleUsd: portfolio.idleUsd.toDecimalPlaces(0).toString(),
  });

  const target = allocate({ snapshots, position: portfolio, riskFlags, cfg: cfg.allocator });
  log.info('allocator.decision', {
    action: target.action,
    summary: target.summary,
    idleWeight: target.idleWeight.mul(100).toDecimalPlaces(1).toString() + '%',
  });
  if (target.action === 'REBALANCE') {
    for (const tw of target.weights) log.info('allocator.target', { reason: tw.rationale });
  }

  const plan = buildRebalancePlan(target, portfolio, snapshots, cfg.assetPriceUsd);
  await simulatePlan(client, log, plan);

  history.append(snapshots.map(toHistorySample));
  await history.save();

  // Empty plan (HOLD, incl. anti-churn HOLD) = no trade; carry the position unchanged.
  state.sim =
    plan.length > 0
      ? simulatePostTradePortfolio(target, snapshots, portfolio.totalUsd, cfg.assetPriceUsd)
      : portfolio;
}

async function screenAdvisory(
  rest: KaminoRestApi,
  cfg: Config,
  log: Logger,
): Promise<void> {
  try {
    const candidates = await fetchScreenCandidates(rest, cfg, log);
    const ranked = screenVaults(candidates, cfg.screener);
    const top = ranked.filter((row) => row.eligible).slice(0, 3);
    log.info('screen.advisory', {
      asset: cfg.asset,
      eligible: ranked.filter((row) => row.eligible).length,
      pinned: cfg.pinnedVaults,
      suggestedTop3: top.map((entry) => `${entry.address} (score ${entry.score.toFixed(2)})`),
      note: 'Advisory only — pinned set is never auto-changed.',
    });
  } catch (err) {
    log.warn('screen.advisory.failed', { err: (err as Error).message });
  }
}

export async function runLoop(initialCfg: Config, log: Logger): Promise<void> {
  requirePinnedVaults(initialCfg, 3);

  const client = await KaminoClient.create(initialCfg);
  const rest = new KaminoRestApi(initialCfg.kaminoApiUrl);
  const history = await History.load(initialCfg.historyPath, initialCfg.historyMax);

  let stop = false;
  const onSig = () => {
    log.info('shutdown', { note: 'signal received — finishing cleanly' });
    stop = true;
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  log.info('paper-trade.enabled', {
    note:
      'pretend fills at the observed share price, no slippage/fees, capital constant. ' +
      'Behaviour demo, not P&L.',
  });

  let cfg = initialCfg;
  const signals = signalsFor(cfg, client);
  const state: LoopState = { sim: undefined, loggedFlags: new Map() };
  let lastScreen = 0;
  let firstTick = true;
  while (!stop) {
    if (!firstTick && cfg.logFormat === 'pretty') console.log('');
    firstTick = false;
    const started = Date.now();
    try {
      const fresh = reloadConfig();
      const { next, hotApplied, restartRequired } = applyHotReload(cfg, fresh);
      if (hotApplied.length > 0) {
        log.info('config.reloaded', { applied: hotApplied });
      }
      if (restartRequired.length > 0) {
        log.warn('config.reload.partial', {
          ignored: restartRequired,
          note: 'restart required for these to take effect',
        });
      }
      cfg = next;
    } catch (err) {
      log.warn('config.reload.failed', { err: (err as Error).message });
    }
    try {
      if (started - lastScreen >= cfg.screenIntervalMs) {
        await screenAdvisory(rest, cfg, log);
        lastScreen = started;
      }
      await runOnce(client, rest, history, cfg, log, signals, state);
    } catch (err) {
      const backoff = err instanceof RateLimitError ? cfg.pollIntervalMs * 3 : cfg.pollIntervalMs;
      log.error('cycle.error', {
        err: (err as Error).message,
        note: `continuing; next attempt in ~${Math.round(backoff / 1000)}s`,
      });
      await sleep(backoff, () => stop);
      continue;
    }
    await sleep(cfg.pollIntervalMs, () => stop);
  }
  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
}

export async function runOnceCli(cfg: Config, log: Logger): Promise<void> {
  requirePinnedVaults(cfg, 3);
  const client = await KaminoClient.create(cfg);
  const rest = new KaminoRestApi(cfg.kaminoApiUrl);
  const history = await History.load(cfg.historyPath, cfg.historyMax);
  const signals = signalsFor(cfg, client);
  const state: LoopState = { sim: undefined, loggedFlags: new Map() };
  await runOnce(client, rest, history, cfg, log, signals, state);
}

export async function runScreenCli(cfg: Config, log: Logger): Promise<void> {
  const rest = new KaminoRestApi(cfg.kaminoApiUrl);
  const candidates = await fetchScreenCandidates(rest, cfg, log);
  const ranked = screenVaults(candidates, cfg.screener);

  const ansi = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };
  const paint = (text: string, code: string) => `${code}${text}${ansi.reset}`;
  const padLeft = (text: string, width: number) => text.padStart(width);
  const padRight = (text: string, width: number) => text.padEnd(width);
  const truncate = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

  // Header and rows share the same widths so they can't drift.
  const COL = { rank: 3, mark: 1, name: 22, score: 6, apy: 7, aum: 9, fee: 6, curator: 11 };

  const eligibleCount = ranked.filter((row) => row.eligible).length;
  console.log(
    `\n${paint('Kamino Earn vault screen', ansi.bold)}  ·  asset ${paint(cfg.asset, ansi.bold)}` +
      `  ·  ${ranked.length} screened  ·  ${paint(`${eligibleCount} eligible`, ansi.green)}\n`,
  );

  const header =
    `${padLeft('#', COL.rank)}  ${padRight('', COL.mark)} ${padRight('name', COL.name)}  ` +
    `${padLeft('score', COL.score)}  ${padLeft('netAPY', COL.apy)}  ${padLeft('90dAPY', COL.apy)}  ` +
    `${padLeft('AUM', COL.aum)}  ${padLeft('fee', COL.fee)}  ${padRight('curator', COL.curator)}  address`;
  console.log(paint(header, ansi.dim));
  console.log(paint('─'.repeat(header.length), ansi.dim));

  ranked.forEach((row, idx) => {
    const mark = row.eligible ? paint('✓', ansi.green) : paint('✗', ansi.red);
    const line =
      `${padLeft(String(idx + 1), COL.rank)}  ${mark} ` +
      `${padRight(truncate(row.summary.name || '(unnamed)', COL.name), COL.name)}  ` +
      `${padLeft(row.score.toFixed(2), COL.score)}  ` +
      `${padLeft(row.summary.netApy, COL.apy)}  ` +
      `${padLeft(row.summary.apy90d, COL.apy)}  ` +
      `${padLeft(row.summary.aumUsd, COL.aum)}  ` +
      `${padLeft(`${row.summary.totalFeeBps}bp`, COL.fee)}  ` +
      `${padRight(row.summary.curator, COL.curator)}  ${row.address}`;
    if (row.eligible) {
      console.log(line);
    } else {
      const failed = row.criteria.filter((crit) => !crit.passed).map((crit) => crit.name).join(', ');
      console.log(paint(`${line}  · failed: ${failed}`, ansi.dim));
    }
  });

  const top3 = ranked.filter((row) => row.eligible).slice(0, 3);
  if (top3.length < 3) {
    console.log(
      `\n${paint(
        `Only ${top3.length} eligible vault(s) — loosen screen filters or raise SCREEN_MAX_VAULTS before pinning.`,
        ansi.red,
      )}\n`,
    );
  } else {
    const addresses = top3.map((entry) => entry.address).join(',');
    console.log(
      `\n${paint('Suggested PINNED_VAULTS', ansi.bold)} ` +
        `${paint('(top 3 by score — review before using)', ansi.dim)}:\n` +
        `  ${paint(`PINNED_VAULTS=${addresses}`, ansi.green)}\n`,
    );
  }
}

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const timer = setInterval(() => {
      waited += step;
      if (cancelled() || waited >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}
