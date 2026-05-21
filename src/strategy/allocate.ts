/**
 * score = wApy·netAPY + wUtil·utilTrend; per-vault cap = block→0, warn→reducedW, else maxW.
 * Greedy waterfall by score. Unabsorbed capital → idle cash, not a worse vault.
 * REBALANCE only when risk-forced or it clears APY-gain / min-move / cost hysteresis.
 */
import { Decimal } from 'decimal.js';
import type {
  AllocatorConfig,
  Portfolio,
  RiskFlag,
  TargetAllocation,
  TargetWeight,
  VaultSnapshot,
} from '../types.js';

export interface AllocateInput {
  snapshots: VaultSnapshot[];
  position: Portfolio;
  riskFlags: RiskFlag[];
  cfg: AllocatorConfig;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function severityOf(vaultId: string, flags: RiskFlag[]): 'none' | 'warn' | 'block' {
  let worst: 'none' | 'warn' | 'block' = 'none';
  for (const flag of flags) {
    if (flag.vaultId !== vaultId) continue;
    if (flag.severity === 'block') return 'block';
    if (flag.severity === 'warn') worst = 'warn';
  }
  return worst;
}

export function allocate(input: AllocateInput): TargetAllocation {
  const { snapshots, position, riskFlags, cfg } = input;
  const total = position.totalUsd;

  const maxW = new Decimal(cfg.maxWeightPct).div(100);
  const reducedW = new Decimal(cfg.riskReducedMaxWeightPct).div(100);

  const ranked = snapshots
    .map((snap) => {
      const sev = severityOf(snap.id, riskFlags);
      const cap = sev === 'block' ? ZERO : sev === 'warn' ? reducedW : maxW;
      const score = new Decimal(cfg.wApy)
        .mul(snap.netApy)
        .plus(new Decimal(cfg.wUtil).mul(snap.utilizationTrend.mul(100)));
      return { snap, sev, cap, score };
    })
    .sort((left, right) => right.score.comparedTo(left.score));

  let remaining = ONE;
  const weights = new Map<string, Decimal>();
  for (const row of ranked) {
    const give = Decimal.min(row.cap, remaining);
    weights.set(row.snap.id, give);
    remaining = remaining.minus(give);
    if (remaining.lte(0)) break;
  }
  for (const row of ranked) if (!weights.has(row.snap.id)) weights.set(row.snap.id, ZERO);
  const idleWeight = Decimal.max(remaining, ZERO);

  const curWeight = new Map<string, Decimal>();
  for (const snap of snapshots) {
    const held = position.byVault.find((pos) => pos.vaultId === snap.id);
    curWeight.set(snap.id, total.lte(0) ? ZERO : (held?.valueUsd ?? ZERO).div(total));
  }

  const apyOf = (weightMap: Map<string, Decimal>) =>
    ranked.reduce((acc, row) => acc.plus((weightMap.get(row.snap.id) ?? ZERO).mul(row.snap.netApy)), ZERO);
  const curApy = apyOf(curWeight);
  const tgtApy = apyOf(weights);
  const deltaBps = tgtApy.minus(curApy).mul(100);
  const expectedAnnualGainUsd = tgtApy.minus(curApy).div(100).mul(total);

  // L1 weight movement across vaults + idle. Including idle keeps the
  // "every $1 moved counts twice (source + destination)" invariant for
  // idle↔vault flows; otherwise movedUsd halves to vault-to-vault volume only.
  let driftL1 = ZERO;
  for (const snap of snapshots) {
    driftL1 = driftL1.plus((weights.get(snap.id) ?? ZERO).minus(curWeight.get(snap.id) ?? ZERO).abs());
  }
  const curIdleWeight = total.lte(0) ? ZERO : position.idleUsd.div(total);
  driftL1 = driftL1.plus(idleWeight.minus(curIdleWeight).abs());
  const movedUsd = driftL1.div(2).mul(total);

  // A held vault now capped below what we hold = a forced move.
  const riskForced = snapshots.some((snap) => {
    const cur = curWeight.get(snap.id) ?? ZERO;
    const tgt = weights.get(snap.id) ?? ZERO;
    return severityOf(snap.id, riskFlags) !== 'none' && tgt.lt(cur.minus(1e-9));
  });

  const rationale = (id: string): string => {
    const row = ranked.find((entry) => entry.snap.id === id)!;
    const cur = curWeight.get(id) ?? ZERO;
    const tgt = weights.get(id) ?? ZERO;
    const sevNote =
      row.sev === 'block'
        ? ' [RISK:block → forced exit]'
        : row.sev === 'warn'
          ? ` [RISK:warn → trimmed to ≤${cfg.riskReducedMaxWeightPct}%]`
          : '';
    return (
      `${id}: ${pct(cur)}→${pct(tgt)} (netAPY ${num(row.snap.netApy)}%, ` +
      `utilΔ ${num(row.snap.utilizationTrend.mul(100))}pp, score ${num(row.score)})${sevNote}`
    );
  };

  const weightList: TargetWeight[] = snapshots.map((snap) => ({
    vaultId: snap.id,
    weight: weights.get(snap.id) ?? ZERO,
    rationale: rationale(snap.id),
  }));

  // ── Decide HOLD vs REBALANCE ──────────────────────────────────────────────
  const negligible = driftL1.lt(0.005);
  let action: 'HOLD' | 'REBALANCE';
  let summary: string;

  if (negligible && !riskForced) {
    action = 'HOLD';
    summary = `HOLD — target ≈ current (drift ${pct(driftL1)}). Portfolio APY ${num(curApy)}%.`;
  } else if (riskForced) {
    action = 'REBALANCE';
    summary =
      `REBALANCE (risk-forced, hysteresis bypassed) — exiting/trimming flagged ` +
      `vault(s). APY ${num(curApy)}%→${num(tgtApy)}%, move ≈ $${num(movedUsd)}.`;
  } else if (
    deltaBps.lt(cfg.improvementThresholdBps) ||
    movedUsd.lt(cfg.minMoveUsd) ||
    expectedAnnualGainUsd.lte(cfg.estMoveCostUsd)
  ) {
    action = 'HOLD';
    summary =
      `HOLD — gain ${num(deltaBps)}bps / move $${num(movedUsd)} / ` +
      `est $${num(expectedAnnualGainUsd)}/yr doesn't clear ` +
      `threshold ${cfg.improvementThresholdBps}bps · $${num(cfg.minMoveUsd)} · ` +
      `$${num(cfg.estMoveCostUsd)} (anti-churn).`;
  } else {
    action = 'REBALANCE';
    summary =
      `REBALANCE — APY ${num(curApy)}%→${num(tgtApy)}% (+${num(deltaBps)}bps), ` +
      `move ≈ $${num(movedUsd)}, est +$${num(expectedAnnualGainUsd)}/yr.`;
  }

  return { action, weights: weightList, idleWeight, summary };
}

const num = (dec: Decimal) => dec.toDecimalPlaces(2).toString();
const pct = (dec: Decimal) => `${dec.mul(100).toDecimalPlaces(1).toString()}%`;
