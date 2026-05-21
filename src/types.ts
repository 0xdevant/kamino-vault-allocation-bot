import { Decimal } from 'decimal.js';

export interface ReserveAllocation {
  reserve: string;
  /** 0..1 */
  targetWeight: Decimal;
}

export interface VaultSnapshot {
  id: string;
  address: string;
  name: string;
  /** Allocator only compares same-asset. */
  asset: string;
  /** APY after fees — what we optimise for. */
  netApy: Decimal;
  grossApy: Decimal;
  apy90d: Decimal;
  performanceFeeBps: number;
  managementFeeBps: number;
  /** tokensAvailableUsd + tokensInvestedUsd (REST). */
  aumUsd: Decimal;
  sharesIssued: Decimal;
  sharePrice: Decimal;
  /** Vault admin authority — the headline curator. */
  curator: string;
  /** Signer that controls allocation ixs; may differ from `curator`. Watched by curator-action. */
  allocationAdmin: string;
  reserves: ReserveAllocation[];
  /** AUM-weighted reserve utilisation (0..1) and short-term trend (positive = rates rising). */
  weightedUtilization: Decimal;
  utilizationTrend: Decimal;
  timestamp: number;
}

export interface VaultPosition {
  vaultId: string;
  shares: Decimal;
  valueUsd: Decimal;
}

export interface Portfolio {
  byVault: VaultPosition[];
  idleUsd: Decimal;
  totalUsd: Decimal;
}

// ── Screener ────────────────────────────────────────────────────────────────

export interface ScreenCriterion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScreenResult {
  id: string;
  address: string;
  asset: string;
  /** Higher is better. */
  score: number;
  eligible: boolean;
  criteria: ScreenCriterion[];
  summary: {
    name: string;
    netApy: string;
    apy90d: string;
    aumUsd: string;
    totalFeeBps: number;
    curator: string;
  };
}

// ── Risk engine ─────────────────────────────────────────────────────────────

export type RiskSeverity = 'info' | 'warn' | 'block';

export interface RiskFlag {
  vaultId: string;
  signal: string;
  severity: RiskSeverity;
  reason: string;
  metric?: Record<string, string>;
}

export interface RiskSignal {
  name: string;
  evaluate(input: RiskSignalInput): Promise<RiskFlag[]> | RiskFlag[];
}

export interface RiskSignalInput {
  snapshots: VaultSnapshot[];
  /** Oldest first. */
  history: HistorySample[];
  config: RiskConfig;
}

// ── Rolling history (delta-based signals) ───────────────────────────────────

export interface HistorySample {
  ts: number;
  vaultId: string;
  aumUsd: string;
  sharesIssued: string;
  weightedUtilization: string;
  allocWeights: { reserve: string; weight: string }[];
}

// ── Allocator output ────────────────────────────────────────────────────────

export interface TargetWeight {
  vaultId: string;
  /** 0..1 */
  weight: Decimal;
  rationale: string;
}

export interface TargetAllocation {
  action: 'HOLD' | 'REBALANCE';
  weights: TargetWeight[];
  /** Fraction held as idle cash (e.g. all vaults risk-blocked). */
  idleWeight: Decimal;
  summary: string;
}

export type RebalanceActionKind = 'WITHDRAW' | 'DEPOSIT';

export interface RebalanceAction {
  kind: RebalanceActionKind;
  vaultId: string;
  address: string;
  amountShares?: Decimal;
  amountTokens?: Decimal;
  reason: string;
}

// ── Config slices (full schema in src/config.ts) ────────────────────────────

export interface AllocatorConfig {
  maxWeightPct: number;
  /** Cap for a vault under a `warn` flag — trim, don't exit. `block` forces 0. */
  riskReducedMaxWeightPct: number;
  wApy: number;
  wUtil: number;
  improvementThresholdBps: number;
  minMoveUsd: Decimal;
  estMoveCostUsd: Decimal;
}

export interface ScreenerConfig {
  asset: string;
  minAumUsd: Decimal;
  maxFeeBps: number;
  minApyPct: Decimal;
  stabilityFloor: number;
  trustedCurators: string[];
}

export interface RiskConfig {
  minAumUsd: Decimal;
  aumDropPct: number;
  allocShiftPct: number;
  /**
   * Staleness guard for window-based signals (alloc-shift, util-trend,
   * max-utilization). Derived from POLL_INTERVAL_MS. Level-only signals
   * (aum-collapse) stay valid across gaps and are not guarded.
   */
  maxSampleAgeMs: number;
  /** Weighted reserve utilisation ≥ maxUtilPct for maxUtilPolls consecutive polls → block. */
  maxUtilPct: number;
  maxUtilPolls: number;
}
