/**
 * Diff target vs. current into ordered actions. Withdrawals first — a withdraw
 * must settle before its realised amount funds a deposit. Sub-dollar deltas are dropped.
 */
import { Decimal } from 'decimal.js';
import type {
  Portfolio,
  RebalanceAction,
  TargetAllocation,
  VaultSnapshot,
} from '../types.js';

const DUST_USD = new Decimal(1);

export function actionAmount(action: RebalanceAction): string {
  return action.kind === 'WITHDRAW'
    ? `${action.amountShares?.toString() ?? '?'} shares`
    : `${action.amountTokens?.toString() ?? '?'} tokens`;
}

export function buildRebalancePlan(
  target: TargetAllocation,
  portfolio: Portfolio,
  snapshots: VaultSnapshot[],
  assetPriceUsd: number,
): RebalanceAction[] {
  if (target.action === 'HOLD') return [];

  const total = portfolio.totalUsd;
  const price = new Decimal(assetPriceUsd);
  const withdrawals: RebalanceAction[] = [];
  const deposits: RebalanceAction[] = [];

  for (const snap of snapshots) {
    const tw = target.weights.find((entry) => entry.vaultId === snap.id);
    const held = portfolio.byVault.find((pos) => pos.vaultId === snap.id);
    const targetUsd = (tw?.weight ?? new Decimal(0)).mul(total);
    const currentUsd = held?.valueUsd ?? new Decimal(0);
    const delta = targetUsd.minus(currentUsd);
    if (delta.abs().lt(DUST_USD)) continue;

    if (delta.isNegative()) {
      if (!held || held.shares.lte(0)) continue;
      const fullExit = targetUsd.lte(DUST_USD);
      const shares = fullExit
        ? held.shares
        : held.shares.mul(delta.abs().div(currentUsd));
      withdrawals.push({
        kind: 'WITHDRAW',
        vaultId: snap.id,
        address: snap.address,
        amountShares: shares,
        reason: fullExit
          ? `Exit ${snap.id}: redeem all ${shares.toDecimalPlaces(4)} shares (~$${currentUsd.toDecimalPlaces(2)}).`
          : `Trim ${snap.id} by $${delta.abs().toDecimalPlaces(2)} (${shares.toDecimalPlaces(4)} shares).`,
      });
    } else {
      deposits.push({
        kind: 'DEPOSIT',
        vaultId: snap.id,
        address: snap.address,
        amountTokens: delta.div(price),
        reason: `Add $${delta.toDecimalPlaces(2)} to ${snap.id} (${delta
          .div(price)
          .toDecimalPlaces(4)} tokens).`,
      });
    }
  }

  return [...withdrawals, ...deposits];
}
