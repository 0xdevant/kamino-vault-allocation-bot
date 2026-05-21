/**
 * `RebalanceAction` → ordered Kamino SDK instructions.
 * Withdraw: unstake → withdraw → postWithdraw. Deposit: deposit → stake.
 * Skipping the farm ixs strands funds in the farm.
 */
import type { TransactionSigner } from '@solana/kit';
import type { KaminoManager } from '@kamino-finance/klend-sdk';
import type { RebalanceAction } from '../types.js';
import type { PinnedVault } from '../data/kaminoClient.js';

type Ix = Parameters<typeof import('@solana/kit')['appendTransactionMessageInstructions']>[0][number];

const flat = (...groups: unknown[]): Ix[] =>
  groups.flatMap((group) => (Array.isArray(group) ? (group as Ix[]) : group ? [group as Ix] : []));

export async function buildActionIxs(
  manager: KaminoManager,
  pv: PinnedVault,
  action: RebalanceAction,
  user: TransactionSigner,
  slot: bigint,
): Promise<Ix[]> {
  // `amountShares`/`amountTokens` are kind-discriminated; one is always set.
  if (action.kind === 'WITHDRAW') {
    const result = (await manager.withdrawFromVaultIxs(
      user,
      pv.vault,
      action.amountShares!,
      slot,
    )) as Record<string, unknown>;
    return flat(result.unstakeFromFarmIfNeededIxs, result.withdrawIxs, result.postWithdrawIxs);
  }
  const result = (await manager.depositToVaultIxs(
    user,
    pv.vault,
    action.amountTokens!,
  )) as Record<string, unknown>;
  return flat(result.depositIxs, result.stakeInFarmIfNeededIxs);
}
