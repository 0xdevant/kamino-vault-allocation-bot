/**
 * AUM below floor → block. AUM down >aumDropPct from window peak → warn; >2× → block.
 * Window peak (not prev sample) so a slow bleed still trips.
 */
import { Decimal } from 'decimal.js';
import type { HistorySample, RiskConfig, RiskFlag, VaultSnapshot } from '../types.js';

export function aumCollapse(
  snapshot: VaultSnapshot,
  vaultHistory: HistorySample[],
  cfg: RiskConfig,
): RiskFlag | null {
  const aum = snapshot.aumUsd;

  if (aum.lt(cfg.minAumUsd)) {
    return {
      vaultId: snapshot.id,
      signal: 'aum-collapse',
      severity: 'block',
      reason: `AUM $${fmt(aum)} below absolute floor $${fmt(cfg.minAumUsd)} — exiting.`,
      metric: { aumUsd: aum.toString(), floorUsd: cfg.minAumUsd.toString() },
    };
  }

  if (vaultHistory.length === 0) return null;
  const peak = vaultHistory.reduce(
    (peakSoFar, sample) => Decimal.max(peakSoFar, new Decimal(sample.aumUsd)),
    aum,
  );
  if (peak.lte(0)) return null;

  const dropPct = peak.minus(aum).div(peak).mul(100);
  if (dropPct.lt(cfg.aumDropPct)) return null;

  const severe = dropPct.gte(cfg.aumDropPct * 2);
  return {
    vaultId: snapshot.id,
    signal: 'aum-collapse',
    severity: severe ? 'block' : 'warn',
    reason:
      `AUM down ${fmt(dropPct)}% from window peak $${fmt(peak)} to $${fmt(aum)} ` +
      `(threshold ${cfg.aumDropPct}%${severe ? `, severe ≥ ${cfg.aumDropPct * 2}%` : ''}).`,
    metric: { dropPct: dropPct.toString(), peakUsd: peak.toString(), aumUsd: aum.toString() },
  };
}

const fmt = (dec: Decimal) => dec.toDecimalPlaces(2).toString();
