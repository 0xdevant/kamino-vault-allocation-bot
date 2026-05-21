/**
 * Block when weightedUtilization ≥ maxUtilPct for ≥ maxUtilPolls consecutive samples.
 * A single spike is mean-reverting yield noise; sustained pinning is when
 * withdrawals actually queue.
 * Docs: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
 */
import { Decimal } from 'decimal.js';
import type { HistorySample, RiskConfig, RiskFlag, VaultSnapshot } from '../types.js';

export function maxUtilization(
  snapshot: VaultSnapshot,
  vaultHistory: HistorySample[],
  cfg: RiskConfig,
): RiskFlag | null {
  const series = [
    ...vaultHistory.map((sample) => new Decimal(sample.weightedUtilization)),
    snapshot.weightedUtilization,
  ];
  if (series.length < cfg.maxUtilPolls) return null;

  // Require the window to span a poll-spaced duration; otherwise stale + fresh
  // samples could fake "sustained" across a downtime gap.
  const historyInWindow = vaultHistory.slice(-(cfg.maxUtilPolls - 1));
  const oldestTs = historyInWindow[0]?.ts;
  if (
    oldestTs !== undefined &&
    snapshot.timestamp - oldestTs > cfg.maxSampleAgeMs * cfg.maxUtilPolls
  ) {
    return null;
  }

  const window = series.slice(-cfg.maxUtilPolls);
  const threshold = new Decimal(cfg.maxUtilPct).div(100);
  const allPinned = window.every((util) => util.gte(threshold));
  if (!allPinned) return null;

  // Report the window minimum so the log shows how pinned it actually was.
  const minUtil = window.reduce((minSoFar, util) => Decimal.min(minSoFar, util), window[0]!);
  return {
    vaultId: snapshot.id,
    signal: 'max-utilization',
    severity: 'block',
    reason:
      `Underlying reserves at ≥ ${minUtil.mul(100).toDecimalPlaces(2)}% utilisation for ` +
      `${cfg.maxUtilPolls} consecutive polls (threshold ${cfg.maxUtilPct}%) — ` +
      `withdrawals will queue; exiting.`,
    metric: {
      minUtilPct: minUtil.mul(100).toString(),
      samples: String(cfg.maxUtilPolls),
    },
  };
}
