import { describe, expect, it } from 'vitest';
import { allocate } from '../src/strategy/allocate.js';
import type { RiskFlag } from '../src/types.js';
import { dec, allocatorCfg, portfolio, snapshot } from './fixtures.js';

const weightOf = (alloc: ReturnType<typeof allocate>, id: string) =>
  alloc.weights.find((tw) => tw.vaultId === id)!.weight;

const three = () => [
  snapshot({ id: 'a', netApy: dec(10) }),
  snapshot({ id: 'b', netApy: dec(8) }),
  snapshot({ id: 'c', netApy: dec(6) }),
];

describe('allocate', () => {
  it('deploys idle cash into the best vaults, respecting the max-weight cap', () => {
    const result = allocate({
      snapshots: three(),
      position: portfolio({ idleUsd: dec(1000) }),
      riskFlags: [],
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('REBALANCE');
    expect(weightOf(result,'a').toNumber()).toBe(0.5); // capped at 50%
    expect(weightOf(result,'b').toNumber()).toBe(0.5);
    expect(weightOf(result,'c').toNumber()).toBe(0); // cap absorbed everything
  });

  it('HOLDs when already at the target allocation', () => {
    const result = allocate({
      snapshots: three(),
      position: portfolio({
        byVault: [
          { vaultId: 'a', shares: dec(1), valueUsd: dec(500) },
          { vaultId: 'b', shares: dec(1), valueUsd: dec(500) },
        ],
      }),
      riskFlags: [],
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('HOLD');
  });

  it('HOLDs (anti-churn) when the allocation differs but APY gain is below threshold', () => {
    const snaps = [
      snapshot({ id: 'a', netApy: dec(8.1) }),
      snapshot({ id: 'b', netApy: dec(8.0) }),
      snapshot({ id: 'c', netApy: dec(8.0) }),
    ];
    // Currently a/c; target wants a/b — but APY barely moves.
    const result = allocate({
      snapshots: snaps,
      position: portfolio({
        byVault: [
          { vaultId: 'a', shares: dec(1), valueUsd: dec(500) },
          { vaultId: 'c', shares: dec(1), valueUsd: dec(500) },
        ],
      }),
      riskFlags: [],
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('HOLD');
    expect(result.summary).toContain('anti-churn');
  });

  it('REBALANCEs when the APY improvement clears the threshold', () => {
    const result = allocate({
      snapshots: [
        snapshot({ id: 'a', netApy: dec(9) }),
        snapshot({ id: 'b', netApy: dec(8) }),
        snapshot({ id: 'c', netApy: dec(6) }),
      ],
      position: portfolio({
        byVault: [
          { vaultId: 'a', shares: dec(1), valueUsd: dec(500) },
          { vaultId: 'c', shares: dec(1), valueUsd: dec(500) },
        ],
      }),
      riskFlags: [],
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('REBALANCE');
  });

  it('a block flag forces a full exit and bypasses anti-churn on tiny amounts', () => {
    const flags: RiskFlag[] = [
      { vaultId: 'a', signal: 'aum-collapse', severity: 'block', reason: 'x' },
    ];
    const result = allocate({
      snapshots: three(),
      position: portfolio({ byVault: [{ vaultId: 'a', shares: dec(1), valueUsd: dec(10) }] }),
      riskFlags: flags,
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('REBALANCE'); // even though move ($) < minMoveUsd
    expect(weightOf(result,'a').toNumber()).toBe(0); // forced out
    expect(result.summary).toContain('risk-forced');
  });

  it('a warn flag trims the vault to the reduced cap instead of exiting', () => {
    const flags: RiskFlag[] = [
      { vaultId: 'a', signal: 'max-utilization', severity: 'warn', reason: 'sustained 100%' },
    ];
    const result = allocate({
      snapshots: three(),
      position: portfolio({ idleUsd: dec(1000) }),
      riskFlags: flags,
      cfg: allocatorCfg,
    });
    expect(weightOf(result,'a').toNumber()).toBe(0.25); // reducedMaxWeightPct
    expect(weightOf(result,'b').toNumber()).toBe(0.5);
    expect(weightOf(result,'c').toNumber()).toBe(0.25); // remainder
  });

  it('parks capital as idle cash when every vault is blocked', () => {
    const flags: RiskFlag[] = ['a', 'b', 'c'].map((vaultId) => ({
      vaultId,
      signal: 'aum-collapse',
      severity: 'block' as const,
      reason: 'x',
    }));
    const result = allocate({
      snapshots: three(),
      position: portfolio({ byVault: [{ vaultId: 'a', shares: dec(1), valueUsd: dec(1000) }] }),
      riskFlags: flags,
      cfg: allocatorCfg,
    });
    expect(result.action).toBe('REBALANCE');
    expect(result.idleWeight.toNumber()).toBe(1);
    expect(result.weights.every((target) => target.weight.isZero())).toBe(true);
  });

  it('uses the utilisation trend as a leading yield signal in ranking', () => {
    const result = allocate({
      snapshots: [
        snapshot({ id: 'a', netApy: dec(8), utilizationTrend: dec(0) }),
        snapshot({ id: 'b', netApy: dec(8), utilizationTrend: dec(0.2) }), // borrow demand rising
        snapshot({ id: 'c', netApy: dec(8), utilizationTrend: dec(0) }),
      ],
      position: portfolio({ idleUsd: dec(1000) }),
      riskFlags: [],
      cfg: allocatorCfg,
    });
    expect(weightOf(result,'b').toNumber()).toBe(0.5); // funded first on the trend edge
    expect(weightOf(result,'c').toNumber()).toBe(0);
  });
});
