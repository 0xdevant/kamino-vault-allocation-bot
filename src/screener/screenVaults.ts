/**
 * Filter same-asset vaults and rank them.
 * Hard filters: AUM ≥ minAumUsd, fees ≤ maxFeeBps, netAPY ≥ minApyPct,
 * apy90d ≥ stabilityFloor·netAPY, optional curator allowlist.
 * Curator track record isn't on-chain-readable; proxied by the
 * allowlist + downstream reserve-health checks.
 */
import { Decimal } from 'decimal.js';
import type { ScreenCriterion, ScreenResult, ScreenerConfig } from '../types.js';

export interface ScreenCandidate {
  id: string;
  address: string;
  name: string;
  asset: string;
  /** Percent (8.5 = 8.5%). */
  netApy: Decimal;
  apy90d: Decimal;
  aumUsd: Decimal;
  performanceFeeBps: number;
  managementFeeBps: number;
  curator: string;
}

// Bonus weights — units are "APY-percent-equivalent" so they add to base APY.
const AUM_ROBUSTNESS_MAX = 1.0;
const STABILITY_BONUS_MAX = 0.5;

const clamp = (val: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, val));

/**
 * Returns every candidate (so the operator sees *why* something was rejected),
 * sorted eligible-first then by descending score.
 */
export function screenVaults(
  candidates: ScreenCandidate[],
  cfg: ScreenerConfig,
): ScreenResult[] {
  const results = candidates.map((cand) => evaluate(cand, cfg));
  return results.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    return right.score - left.score;
  });
}

function evaluate(cand: ScreenCandidate, cfg: ScreenerConfig): ScreenResult {
  const totalFeeBps = cand.performanceFeeBps + cand.managementFeeBps;
  const criteria: ScreenCriterion[] = [];

  // ── Hard filters ──────────────────────────────────────────────────────────
  const assetOk = cand.asset.toUpperCase() === cfg.asset.toUpperCase();
  criteria.push({
    name: 'asset',
    passed: assetOk,
    detail: assetOk
      ? `asset ${cand.asset} matches target`
      : `asset ${cand.asset} != target ${cfg.asset} (APY only comparable same-asset)`,
  });

  const aumOk = cand.aumUsd.gte(cfg.minAumUsd);
  criteria.push({
    name: 'aum',
    passed: aumOk,
    detail: `AUM $${fmt(cand.aumUsd)} ${aumOk ? '>=' : '<'} floor $${fmt(cfg.minAumUsd)}`,
  });

  const feeOk = totalFeeBps <= cfg.maxFeeBps;
  criteria.push({
    name: 'fees',
    passed: feeOk,
    detail: `total fee ${totalFeeBps}bps (perf ${cand.performanceFeeBps} + mgmt ${cand.managementFeeBps}) ${
      feeOk ? '<=' : '>'
    } cap ${cfg.maxFeeBps}bps`,
  });

  const apyOk = cand.netApy.gte(cfg.minApyPct);
  criteria.push({
    name: 'apy-floor',
    passed: apyOk,
    detail: `net APY ${fmt(cand.netApy)}% ${apyOk ? '>=' : '<'} floor ${fmt(cfg.minApyPct)}%`,
  });

  // Guard against transient spikes: 90d APY must be ≥ stabilityFloor × current.
  const stabilityMin = cand.netApy.mul(cfg.stabilityFloor);
  const stableOk = cand.netApy.lte(0) ? true : cand.apy90d.gte(stabilityMin);
  criteria.push({
    name: 'stability',
    passed: stableOk,
    detail: `90d APY ${fmt(cand.apy90d)}% vs required ${fmt(stabilityMin)}% (= ${
      cfg.stabilityFloor
    } x current ${fmt(cand.netApy)}%)`,
  });

  // Only a hard gate when an allowlist is configured.
  const hasAllowlist = cfg.trustedCurators.length > 0;
  const curatorOk = !hasAllowlist || cfg.trustedCurators.includes(cand.curator);
  criteria.push({
    name: 'curator',
    passed: curatorOk,
    detail: hasAllowlist
      ? `curator ${short(cand.curator)} ${curatorOk ? 'is on' : 'NOT on'} the trusted allowlist`
      : `no curator allowlist configured — advisory only (curator ${short(cand.curator)})`,
  });

  const eligible = criteria.every((crit) => crit.passed);

  // ── Transparent score (only meaningful for eligible vaults) ───────────────
  const base = cand.netApy.toNumber();

  const aumRatio = cfg.minAumUsd.lte(0)
    ? 1
    : cand.aumUsd.div(cfg.minAumUsd).toNumber();
  const aumRobustness =
    clamp(Math.log10(Math.max(aumRatio, 1)), 0, 2) * (AUM_ROBUSTNESS_MAX / 2);

  const stabilityRatio = cand.netApy.lte(0) ? 1 : cand.apy90d.div(cand.netApy).toNumber();
  const stabilityBonus =
    clamp(stabilityRatio - 1, -1, 1) * STABILITY_BONUS_MAX;

  const score = Number((base + aumRobustness + stabilityBonus).toFixed(4));
  criteria.push({
    name: 'score-breakdown',
    passed: true,
    detail:
      `score ${score} = base ${base.toFixed(2)} ` +
      `+ aum ${aumRobustness.toFixed(3)} ` +
      `+ stability ${stabilityBonus.toFixed(3)}`,
  });

  return {
    id: cand.id,
    address: cand.address,
    asset: cand.asset,
    score,
    eligible,
    criteria,
    summary: {
      name: cand.name,
      netApy: `${cand.netApy.toFixed(2)}%`,
      apy90d: `${cand.apy90d.toFixed(2)}%`,
      aumUsd: humanUsd(cand.aumUsd),
      totalFeeBps,
      curator: short(cand.curator),
    },
  };
}

function fmt(dec: Decimal): string {
  return dec.toDecimalPlaces(2).toString();
}
function short(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}
function humanUsd(dec: Decimal): string {
  const num = dec.toNumber();
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}
