import { describe, expect, it } from 'vitest';
import { allocate } from '../src/strategy/allocate.js';
import { simulatePostTradePortfolio } from '../src/data/vaultData.js';
import { dec, allocatorCfg, portfolio, snapshot } from './fixtures.js';

// The dry-run paper-trading guarantee: deploy once, then converge to HOLD.
const snaps = [
  snapshot({ id: 'a', netApy: dec(10) }),
  snapshot({ id: 'b', netApy: dec(8) }),
  snapshot({ id: 'c', netApy: dec(6) }),
];

describe('simulatePostTradePortfolio', () => {
  it('round-trips a target so the next allocate() HOLDs (convergence)', () => {
    const cfg = allocatorCfg;

    // Cycle 1: all idle → deploy.
    const first = allocate({
      snapshots: snaps,
      position: portfolio({ idleUsd: dec(100_000) }),
      riskFlags: [],
      cfg,
    });
    expect(first.action).toBe('REBALANCE');

    // Pretend the plan filled.
    const sim = simulatePostTradePortfolio(first, snaps, dec(100_000), 1);
    // Capital is conserved and weights are preserved exactly.
    const sum = sim.byVault
      .reduce((acc, pos) => acc.plus(pos.valueUsd), dec(0))
      .plus(sim.idleUsd);
    expect(sum.toNumber()).toBeCloseTo(100_000, 6);
    const wA = sim.byVault.find((pos) => pos.vaultId === 'a')!.valueUsd.div(100_000);
    expect(wA.toNumber()).toBeCloseTo(0.5, 9); // capped at maxWeightPct

    // Cycle 2: feed it back → no drift → HOLD (not a repeated deposit).
    const second = allocate({ snapshots: snaps, position: sim, riskFlags: [], cfg });
    expect(second.action).toBe('HOLD');
    expect(second.summary).toContain('target ≈ current');
  });

  it('re-trades when real data moves enough to clear the gate', () => {
    const cfg = allocatorCfg;
    const sim = simulatePostTradePortfolio(
      allocate({ snapshots: snaps, position: portfolio({ idleUsd: dec(100_000) }), riskFlags: [], cfg }),
      snaps,
      dec(100_000),
      1,
    );
    // 'c' suddenly outyields everything → target shifts → REBALANCE.
    const moved = [
      snapshot({ id: 'a', netApy: dec(10) }),
      snapshot({ id: 'b', netApy: dec(8) }),
      snapshot({ id: 'c', netApy: dec(25) }),
    ];
    const next = allocate({ snapshots: moved, position: sim, riskFlags: [], cfg });
    expect(next.action).toBe('REBALANCE');
  });

  it('drops zero-weight vaults and parks idle weight as cash', () => {
    const sim = simulatePostTradePortfolio(
      allocate({ snapshots: snaps, position: portfolio({ idleUsd: dec(100_000) }), riskFlags: [], cfg: allocatorCfg }),
      snaps,
      dec(100_000),
      1,
    );
    expect(sim.byVault.some((pos) => pos.vaultId === 'c')).toBe(false); // c weight 0
    expect(sim.idleUsd.toNumber()).toBe(0); // 50 + 50 fully deployed
  });
});
