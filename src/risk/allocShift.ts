/**
 * TVD of curator-set vault→reserve weights vs. prior sample.
 * ≥ allocShiftPct → warn; ≥ 2× → block. Doesn't distinguish rebalance from pull.
 */
import { Decimal } from 'decimal.js';
import type { HistorySample, RiskConfig, RiskFlag, VaultSnapshot } from '../types.js';

export function allocShift(
  snapshot: VaultSnapshot,
  vaultHistory: HistorySample[],
  cfg: RiskConfig,
): RiskFlag | null {
  if (vaultHistory.length === 0) return null;
  const prev = vaultHistory[vaultHistory.length - 1]!;

  // Per-poll delta only: skip if the baseline is stale (downtime, not a real move).
  if (snapshot.timestamp - prev.ts > cfg.maxSampleAgeMs) return null;

  const prevW = new Map<string, Decimal>();
  for (const entry of prev.allocWeights) prevW.set(entry.reserve, new Decimal(entry.weight));
  const nowW = new Map<string, Decimal>();
  for (const alloc of snapshot.reserves) nowW.set(alloc.reserve, alloc.targetWeight);

  const reserves = new Set<string>([...prevW.keys(), ...nowW.keys()]);
  let tvd = new Decimal(0);
  for (const reserve of reserves) {
    tvd = tvd.plus((nowW.get(reserve) ?? new Decimal(0)).minus(prevW.get(reserve) ?? new Decimal(0)).abs());
  }
  const shiftPct = tvd.div(2).mul(100);
  if (shiftPct.lt(cfg.allocShiftPct)) return null;

  const severe = shiftPct.gte(cfg.allocShiftPct * 2);
  return {
    vaultId: snapshot.id,
    signal: 'alloc-shift',
    severity: severe ? 'block' : 'warn',
    reason:
      `Vault→reserve allocation shifted ${fmt(shiftPct)}% since last poll ` +
      `(threshold ${cfg.allocShiftPct}%). Heuristic for a curator liquidity ` +
      `pull — could be a benign rebalance; ${severe ? 'extreme → exiting' : 'trimming & watching'}.`,
    metric: { shiftPct: shiftPct.toString() },
  };
}

const fmt = (dec: Decimal) => dec.toDecimalPlaces(2).toString();
