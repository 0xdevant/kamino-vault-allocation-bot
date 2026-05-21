/**
 * AUM-weighted borrow utilisation across a vault's Klend reserves. Used by the
 * allocator's util-trend term and the max-utilization risk signal.
 */
import { Decimal } from 'decimal.js';
import type { KaminoManager } from '@kamino-finance/klend-sdk';

export interface WeightedUtil {
  /** 0..1 */
  weighted: Decimal;
  perReserve: { reserve: string; util: Decimal; weight: Decimal }[];
}

export async function computeWeightedUtilization(
  manager: KaminoManager,
  vaultState: Parameters<KaminoManager['getVaultAllocations']>[0],
  /** Reuse an already-loaded reserves map to skip a duplicate RPC fetch. */
  preloadedReserves?: Awaited<ReturnType<KaminoManager['loadVaultReserves']>>,
): Promise<WeightedUtil> {
  const reserves = preloadedReserves ?? (await manager.loadVaultReserves(vaultState));
  const allocations = manager.getVaultAllocations(vaultState);

  const perReserve: WeightedUtil['perReserve'] = [];
  let weightSum = new Decimal(0);
  let acc = new Decimal(0);

  for (const [reserveAddr, alloc] of allocations.entries()) {
    const reserve = reserves.get(reserveAddr);
    if (!reserve) continue;
    const util = new Decimal(reserve.calculateUtilizationRatio());
    const weight = new Decimal(alloc.targetWeight.toString());
    if (weight.lte(0)) continue;
    perReserve.push({ reserve: String(reserveAddr), util, weight });
    acc = acc.plus(util.mul(weight));
    weightSum = weightSum.plus(weight);
  }

  const weighted = weightSum.gt(0) ? acc.div(weightSum) : new Decimal(0);
  return { weighted, perReserve };
}
