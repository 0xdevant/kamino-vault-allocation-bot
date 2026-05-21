import { describe, expect, it } from 'vitest';
import { aumCollapse } from '../src/risk/aumCollapse.js';
import { allocShift } from '../src/risk/allocShift.js';
import { maxUtilization } from '../src/risk/maxUtilization.js';
import { dec, hist, riskCfg, snapshot } from './fixtures.js';

describe('aumCollapse', () => {
  it('blocks below the absolute floor', () => {
    const flag = aumCollapse(snapshot({ aumUsd: dec(500_000) }), [], riskCfg);
    expect(flag?.severity).toBe('block');
  });
  it('warns on a >30% drop from the window peak, blocks on >60%', () => {
    const history = [hist({ aumUsd: '10000000' })];
    expect(aumCollapse(snapshot({ aumUsd: dec(6_900_000) }), history, riskCfg)?.severity).toBe('warn');
    expect(aumCollapse(snapshot({ aumUsd: dec(3_500_000) }), history, riskCfg)?.severity).toBe('block');
  });
  it('is silent when AUM is stable', () => {
    expect(aumCollapse(snapshot(), [hist()], riskCfg)).toBeNull();
  });
});

describe('allocShift', () => {
  it('warns on a large vault→reserve weight swing (curator-pull heuristic)', () => {
    const prev = hist({
      allocWeights: [
        { reserve: 'R1', weight: '0.9' },
        { reserve: 'R2', weight: '0.1' },
      ],
    });
    const snap = snapshot({
      reserves: [
        { reserve: 'R1', targetWeight: dec(0.1) },
        { reserve: 'R2', targetWeight: dec(0.9) },
      ],
    });
    const flag = allocShift(snap, [prev], riskCfg); // TVD = 0.8 -> 80%
    expect(flag?.severity).toBe('block'); // 80% >= 2*40
  });
  it('does not flag a swing measured against a stale baseline', () => {
    const bigSwing = {
      prev: hist({
        ts: 0,
        allocWeights: [
          { reserve: 'R1', weight: '0.9' },
          { reserve: 'R2', weight: '0.1' },
        ],
      }),
      reserves: [
        { reserve: 'R1', targetWeight: dec(0.1) },
        { reserve: 'R2', targetWeight: dec(0.9) },
      ],
    };
    // Same 80% TVD that blocks when poll-fresh...
    expect(
      allocShift(snapshot({ timestamp: 1_000, reserves: bigSwing.reserves }), [bigSwing.prev], riskCfg)
        ?.severity,
    ).toBe('block');
    // ...is suppressed when the only baseline is older than maxSampleAgeMs
    // (300_000) — a long-gap drift is not a "since last poll" curator pull.
    expect(
      allocShift(snapshot({ timestamp: 400_000, reserves: bigSwing.reserves }), [bigSwing.prev], riskCfg),
    ).toBeNull();
  });
  it('is silent on small reallocations', () => {
    const prev = hist({
      allocWeights: [
        { reserve: 'R1', weight: '0.6' },
        { reserve: 'R2', weight: '0.4' },
      ],
    });
    const snap = snapshot({
      reserves: [
        { reserve: 'R1', targetWeight: dec(0.62) },
        { reserve: 'R2', targetWeight: dec(0.38) },
      ],
    });
    expect(allocShift(snap, [prev], riskCfg)).toBeNull();
  });
});

describe('maxUtilization', () => {
  // riskCfg has maxUtilPct=99.9, maxUtilPolls=3 (fixture set below).
  const pinned = (util: string) => hist({ weightedUtilization: util });

  it('blocks when reserves stay ≥ threshold across the full window', () => {
    const history = [pinned('1.0'), pinned('0.9995'), pinned('1.0')];
    const flag = maxUtilization(snapshot({ weightedUtilization: dec(0.9999) }), history, riskCfg);
    expect(flag?.severity).toBe('block');
    expect(flag?.reason).toContain('consecutive polls');
  });
  it('ignores a transient spike that is not sustained (mean-revert case)', () => {
    // Brief touch of full utilisation, then back down — yield-bullish, not a lockup.
    const history = [pinned('0.92'), pinned('1.0'), pinned('0.93')];
    expect(maxUtilization(snapshot({ weightedUtilization: dec(0.95) }), history, riskCfg)).toBeNull();
  });
  it('returns null without enough history to confirm persistence', () => {
    expect(maxUtilization(snapshot({ weightedUtilization: dec(1.0) }), [pinned('1.0')], riskCfg)).toBeNull();
  });
  it('does not fire at normal ~95% utilisation', () => {
    const history = [pinned('0.95'), pinned('0.95'), pinned('0.95')];
    expect(maxUtilization(snapshot({ weightedUtilization: dec(0.95) }), history, riskCfg)).toBeNull();
  });
  it('does not fire when the window spans downtime', () => {
    // riskCfg: maxSampleAgeMs=300_000, maxUtilPolls=3 → window must span
    // ≤ 900_000ms. Two stale ≥-threshold history points from > an hour ago,
    // joined to a fresh ≥-threshold current reading, would look "sustained"
    // — the staleness guard rejects that.
    const hourMs = 60 * 60 * 1000;
    const history = [
      hist({ ts: 0, weightedUtilization: '1.0' }),
      hist({ ts: 60_000, weightedUtilization: '1.0' }),
    ];
    const snap = snapshot({ timestamp: hourMs, weightedUtilization: dec(1.0) });
    expect(maxUtilization(snap, history, riskCfg)).toBeNull();
  });
});
