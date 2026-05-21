/**
 * Built-in evaluators + pluggable signals → flat `RiskFlag[]`. Pure combinator.
 * Severity: block → weight 0, warn → reduced cap, info → logged only.
 */
import type { RiskConfig, RiskFlag, RiskSignal, VaultSnapshot } from '../types.js';
import type { History } from '../data/history.js';
import { aumCollapse } from './aumCollapse.js';
import { allocShift } from './allocShift.js';
import { maxUtilization } from './maxUtilization.js';

export async function evaluateRisk(
  snapshots: VaultSnapshot[],
  history: History,
  cfg: RiskConfig,
  signals: RiskSignal[] = [],
): Promise<RiskFlag[]> {
  const flags: RiskFlag[] = [];

  for (const snap of snapshots) {
    const vh = history.forVault(snap.id);
    for (const flag of [
      aumCollapse(snap, vh, cfg),
      allocShift(snap, vh, cfg),
      maxUtilization(snap, vh, cfg),
    ]) {
      if (flag) flags.push(flag);
    }
  }

  for (const sig of signals) {
    const produced = await sig.evaluate({
      snapshots,
      history: history.all(),
      config: cfg,
    });
    flags.push(...produced);
  }

  return flags;
}

export function worstSeverity(
  vaultId: string,
  flags: RiskFlag[],
): 'none' | 'info' | 'warn' | 'block' {
  const rank = { none: 0, info: 1, warn: 2, block: 3 } as const;
  let worst: 'none' | 'info' | 'warn' | 'block' = 'none';
  for (const flag of flags) {
    if (flag.vaultId === vaultId && rank[flag.severity] > rank[worst]) worst = flag.severity;
  }
  return worst;
}
