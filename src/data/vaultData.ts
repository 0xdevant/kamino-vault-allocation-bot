/**
 * Adapter from Kamino REST + SDK to the plain shapes the core consumes.
 * REST → APY/AUM/fees/curator/sharePrice (screening RPC-free).
 * SDK  → reserve utilisation for pinned vaults.
 */
import { Decimal } from 'decimal.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type {
  HistorySample,
  Portfolio,
  TargetAllocation,
  VaultPosition,
  VaultSnapshot,
} from '../types.js';
import type { ScreenCandidate } from '../screener/screenVaults.js';
import type { KaminoClient } from './kaminoClient.js';
import { decodeVaultName, type KaminoRestApi, type RestVaultMetrics } from './restApi.js';
import { computeWeightedUtilization } from './utilization.js';

const SYMBOL_MINT: Record<string, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  SOL: 'So11111111111111111111111111111111111111112',
};
const MINT_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_MINT).map(([k, v]) => [v, k]),
);

/** Accepts a symbol OR a raw mint. */
function assetMint(asset: string): string | undefined {
  if (SYMBOL_MINT[asset]) return SYMBOL_MINT[asset];
  if (asset.length >= 32 && asset.length <= 44) return asset;
  return undefined;
}
const assetLabel = (mint: string, fallback: string) => MINT_SYMBOL[mint] ?? fallback;

const toDecimalOr0 = (value: unknown): Decimal =>
  value instanceof Decimal ? value : new Decimal(String(value ?? 0));

function apyPct(val: Decimal | undefined, cfg: Config): Decimal {
  if (!val) return new Decimal(0);
  return cfg.apyIsFraction ? val.mul(100) : val;
}
const aumOf = (metrics: RestVaultMetrics): Decimal =>
  (metrics.tokensAvailableUsd ?? new Decimal(0)).plus(metrics.tokensInvestedUsd ?? new Decimal(0));

export async function fetchVaultSnapshots(
  client: KaminoClient,
  rest: KaminoRestApi,
  history: { forVault(id: string): HistorySample[] },
  cfg: Config,
  log: Logger,
): Promise<VaultSnapshot[]> {
  const out: VaultSnapshot[] = [];

  for (const pv of client.vaults) {
    const metrics = await rest.vaultMetrics(pv.address);
    const aumUsd = aumOf(metrics);
    const netApy = apyPct(metrics.apy ?? metrics.apy30d, cfg);

    // Degrade gracefully if reserves can't be loaded — fall back to APY-only.
    let weighted = new Decimal(0);
    let reservesAlloc: { reserve: string; targetWeight: Decimal }[] = [];
    let curator = '';
    let allocationAdmin = '';
    let name = '';
    let perfBps = 0;
    let mgmtBps = 0;
    let mint = '';
    try {
      const state = await pv.vault.getState();
      // VaultState is internal codegen and not exported — widen and cast per field.
      const stateRec = state as unknown as Record<string, unknown>;
      name = decodeVaultName(stateRec.name);
      curator = String(stateRec.vaultAdminAuthority ?? '');
      allocationAdmin = String(stateRec.allocationAdmin ?? '');
      perfBps = Number(String(stateRec.performanceFeeBps ?? 0));
      mgmtBps = Number(String(stateRec.managementFeeBps ?? 0));
      mint = String(stateRec.tokenMint ?? '');

      const reserves = await client.manager.loadVaultReserves(state);
      const util = await computeWeightedUtilization(client.manager, state, reserves);
      weighted = util.weighted;

      const allocs = client.manager.getVaultAllocations(state);
      let weightSum = new Decimal(0);
      const raw: { reserve: string; weight: Decimal }[] = [];
      for (const [reserve, alloc] of allocs.entries()) {
        const weight = toDecimalOr0(alloc.targetWeight);
        raw.push({ reserve: String(reserve), weight });
        weightSum = weightSum.plus(weight);
      }
      reservesAlloc = raw.map((entry) => ({
        reserve: entry.reserve,
        targetWeight: weightSum.gt(0) ? entry.weight.div(weightSum) : new Decimal(0),
      }));
    } catch (err) {
      log.warn('snapshot.sdk.degraded', {
        vault: pv.id,
        err: (err as Error).message,
        note: 'utilisation/allocations unavailable this cycle — APY-only',
      });
    }

    // One clock reading so allocShift's staleness guard judges the same gap.
    const now = Date.now();
    const last = history.forVault(pv.id).at(-1);
    // Only diff against a poll-fresh baseline; stale → skip the trend this cycle.
    const prev =
      last && now - last.ts <= cfg.risk.maxSampleAgeMs ? last : undefined;
    const trend = prev
      ? weighted.minus(new Decimal(prev.weightedUtilization))
      : new Decimal(0);

    out.push({
      id: pv.id,
      address: pv.address,
      name,
      asset: assetLabel(mint, cfg.asset),
      netApy,
      grossApy: apyPct(metrics.apyTheoretical ?? metrics.apy, cfg),
      apy90d: apyPct(metrics.apy90d ?? metrics.apy30d ?? metrics.apy, cfg),
      performanceFeeBps: perfBps,
      managementFeeBps: mgmtBps,
      aumUsd,
      sharesIssued: toDecimalOr0(metrics.sharesIssued),
      sharePrice: toDecimalOr0(metrics.sharePrice),
      curator,
      allocationAdmin,
      reserves: reservesAlloc,
      weightedUtilization: weighted,
      utilizationTrend: trend,
      timestamp: now,
    });
  }
  return out;
}

/**
 * Paper-trade carry: the portfolio if the plan filled at observed share price,
 * no slippage/fees. Weights round-trip exactly via this valuation.
 */
export function simulatePostTradePortfolio(
  target: TargetAllocation,
  snapshots: VaultSnapshot[],
  totalUsd: Decimal,
  assetPriceUsd: number,
): Portfolio {
  const price = new Decimal(assetPriceUsd);
  const byVault: VaultPosition[] = [];
  for (const tw of target.weights) {
    if (tw.weight.lte(0)) continue;
    const snap = snapshots.find((entry) => entry.id === tw.vaultId);
    const valueUsd = tw.weight.mul(totalUsd);
    const sharePrice = snap?.sharePrice ?? new Decimal(0);
    const shares =
      sharePrice.gt(0) && price.gt(0) ? valueUsd.div(sharePrice.mul(price)) : new Decimal(0);
    byVault.push({ vaultId: tw.vaultId, shares, valueUsd });
  }
  return { byVault, idleUsd: target.idleWeight.mul(totalUsd), totalUsd };
}

export function toHistorySample(snap: VaultSnapshot): HistorySample {
  return {
    ts: snap.timestamp,
    vaultId: snap.id,
    aumUsd: snap.aumUsd.toString(),
    sharesIssued: snap.sharesIssued.toString(),
    weightedUtilization: snap.weightedUtilization.toString(),
    allocWeights: snap.reserves.map((reserve) => ({
      reserve: reserve.reserve,
      weight: reserve.targetWeight.toString(),
    })),
  };
}

/**
 * REST-only. Pre-filters by mint before metrics — dozens of calls, not hundreds.
 */
export async function fetchScreenCandidates(
  rest: KaminoRestApi,
  cfg: Config,
  log: Logger,
): Promise<ScreenCandidate[]> {
  const availableVaults = await rest.listVaults();
  const targetMint = assetMint(cfg.asset);
  const sameAsset = targetMint
    ? availableVaults.filter((vault) => vault.state.tokenMint === targetMint)
    : availableVaults;
  // Cheap size proxy (raw prevAum) so SCREEN_MAX_VAULTS keeps the largest, not the first listed.
  const picked = [...sameAsset]
    .sort((left, right) => right.state.prevAum - left.state.prevAum)
    .slice(0, cfg.screenMaxVaults);
  log.debug('screen.available', {
    total: availableVaults.length,
    sameAsset: sameAsset.length,
    screening: picked.length,
  });

  const out: ScreenCandidate[] = [];
  const POOL = 8;
  for (let start = 0; start < picked.length; start += POOL) {
    const batch = picked.slice(start, start + POOL);
    const rows = await Promise.all(
      batch.map(async (vault, idx) => {
        try {
          const metrics = await rest.vaultMetrics(vault.address);
          return {
            id: `c${start + idx + 1}`,
            address: vault.address,
            name: vault.state.name,
            asset: assetLabel(vault.state.tokenMint, cfg.asset),
            netApy: apyPct(metrics.apy ?? metrics.apy30d, cfg),
            apy90d: apyPct(metrics.apy90d ?? metrics.apy30d ?? metrics.apy, cfg),
            aumUsd: aumOf(metrics),
            performanceFeeBps: vault.state.performanceFeeBps,
            managementFeeBps: vault.state.managementFeeBps,
            curator: vault.state.vaultAdminAuthority,
          } satisfies ScreenCandidate;
        } catch (err) {
          log.debug('screen.vault.skip', { vault: vault.address, err: (err as Error).message });
          return null;
        }
      }),
    );
    for (const row of rows) if (row) out.push(row);
  }
  return out;
}
