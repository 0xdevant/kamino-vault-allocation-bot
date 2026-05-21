/**
 * Test fixtures — builders with sane defaults so each test only states the
 * field it actually cares about. No network, no SDK.
 */
import { Decimal } from 'decimal.js';
import type {
  AllocatorConfig,
  HistorySample,
  Portfolio,
  RiskConfig,
  ScreenerConfig,
  VaultSnapshot,
} from '../src/types.js';
import type { ScreenCandidate } from '../src/screener/screenVaults.js';

const dec = (val: number | string) => new Decimal(val);

export function snapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    id: 'v1',
    address: 'Addr1',
    name: 'Test Vault USDC',
    asset: 'USDC',
    netApy: dec(8),
    grossApy: dec(9),
    apy90d: dec(8),
    performanceFeeBps: 1000,
    managementFeeBps: 0,
    aumUsd: dec(10_000_000),
    sharesIssued: dec(1_000_000),
    sharePrice: dec(1),
    curator: 'CuratorTrusted1111111111111111111111111111',
    allocationAdmin: 'AllocAdmin11111111111111111111111111111111',
    reserves: [
      { reserve: 'R1', targetWeight: dec(0.6) },
      { reserve: 'R2', targetWeight: dec(0.4) },
    ],
    weightedUtilization: dec(0.5),
    utilizationTrend: dec(0),
    timestamp: 1_000,
    ...over,
  };
}

export function candidate(over: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    id: 'v1',
    address: 'Addr1',
    name: 'Test Vault USDC',
    asset: 'USDC',
    netApy: dec(8),
    apy90d: dec(8),
    aumUsd: dec(10_000_000),
    performanceFeeBps: 1000,
    managementFeeBps: 0,
    curator: 'CuratorTrusted1111111111111111111111111111',
    ...over,
  };
}

export function hist(over: Partial<HistorySample> = {}): HistorySample {
  return {
    ts: 0,
    vaultId: 'v1',
    aumUsd: '10000000',
    sharesIssued: '1000000',
    weightedUtilization: '0.5',
    allocWeights: [
      { reserve: 'R1', weight: '0.6' },
      { reserve: 'R2', weight: '0.4' },
    ],
    ...over,
  };
}

export function portfolio(over: Partial<Portfolio> = {}): Portfolio {
  const byVault = over.byVault ?? [];
  const idleUsd = over.idleUsd ?? dec(0);
  const totalUsd =
    over.totalUsd ?? byVault.reduce((sum, pos) => sum.plus(pos.valueUsd), new Decimal(0)).plus(idleUsd);
  return { byVault, idleUsd, totalUsd };
}

export const screenerCfg: ScreenerConfig = {
  asset: 'USDC',
  minAumUsd: dec(1_000_000),
  maxFeeBps: 2000,
  minApyPct: dec(2),
  stabilityFloor: 0.7,
  trustedCurators: [],
};

export const allocatorCfg: AllocatorConfig = {
  maxWeightPct: 50,
  riskReducedMaxWeightPct: 25,
  wApy: 0.8,
  wUtil: 0.2,
  improvementThresholdBps: 50,
  minMoveUsd: dec(25),
  estMoveCostUsd: dec(0.05),
};

export const riskCfg: RiskConfig = {
  minAumUsd: dec(1_000_000),
  aumDropPct: 30,
  allocShiftPct: 40,
  maxSampleAgeMs: 300_000, // 5 × default 60s poll
  maxUtilPct: 99.9,
  maxUtilPolls: 3, // small for tests — production derives from MAX_UTIL_SUSTAIN_MS / POLL_INTERVAL_MS
};

export { dec };
