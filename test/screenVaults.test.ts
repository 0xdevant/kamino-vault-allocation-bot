import { describe, expect, it } from 'vitest';
import { screenVaults } from '../src/screener/screenVaults.js';
import { dec, candidate, screenerCfg } from './fixtures.js';

describe('screenVaults', () => {
  it('passes a healthy vault and exposes a transparent score breakdown', () => {
    const [result] = screenVaults([candidate()], screenerCfg);
    expect(result!.eligible).toBe(true);
    expect(result!.criteria.find((crit) => crit.name === 'score-breakdown')).toBeTruthy();
    expect(result!.score).toBeGreaterThan(0);
  });

  it('rejects on AUM floor, fee ceiling, APY floor and wrong asset', () => {
    const lowAum = screenVaults([candidate({ aumUsd: dec(100) })], screenerCfg)[0]!;
    expect(lowAum.eligible).toBe(false);
    expect(lowAum.criteria.find((crit) => crit.name === 'aum')!.passed).toBe(false);

    const highFee = screenVaults(
      [candidate({ performanceFeeBps: 1500, managementFeeBps: 1000 })],
      screenerCfg,
    )[0]!;
    expect(highFee.criteria.find((crit) => crit.name === 'fees')!.passed).toBe(false);

    const lowApy = screenVaults([candidate({ netApy: dec(1) })], screenerCfg)[0]!;
    expect(lowApy.criteria.find((crit) => crit.name === 'apy-floor')!.passed).toBe(false);

    const wrongAsset = screenVaults([candidate({ asset: 'SOL' })], screenerCfg)[0]!;
    expect(wrongAsset.criteria.find((crit) => crit.name === 'asset')!.passed).toBe(false);
  });

  it('rejects a transient APY spike via the 90d stability check', () => {
    // current 20%, 90d only 5% -> 5 < 0.7*20=14 -> fails
    const spike = screenVaults([candidate({ netApy: dec(20), apy90d: dec(5) })], screenerCfg)[0]!;
    expect(spike.criteria.find((crit) => crit.name === 'stability')!.passed).toBe(false);
    expect(spike.eligible).toBe(false);
  });

  it('treats the curator allowlist as a hard gate only when configured', () => {
    const noList = screenVaults([candidate({ curator: 'Unknown' })], screenerCfg)[0]!;
    expect(noList.criteria.find((crit) => crit.name === 'curator')!.passed).toBe(true);

    const cfg = { ...screenerCfg, trustedCurators: ['GoodCurator'] };
    const blocked = screenVaults([candidate({ curator: 'Unknown' })], cfg)[0]!;
    expect(blocked.criteria.find((crit) => crit.name === 'curator')!.passed).toBe(false);
    const allowed = screenVaults([candidate({ curator: 'GoodCurator' })], cfg)[0]!;
    expect(allowed.criteria.find((crit) => crit.name === 'curator')!.passed).toBe(true);
  });

  it('ranks eligible vaults first, then by descending score', () => {
    const results = screenVaults(
      [
        candidate({ id: 'low', netApy: dec(4), apy90d: dec(4) }),
        candidate({ id: 'high', netApy: dec(12), apy90d: dec(12) }),
        candidate({ id: 'bad', aumUsd: dec(1) }), // ineligible
      ],
      screenerCfg,
    );
    expect(results.map((result) => result.id)).toEqual(['high', 'low', 'bad']);
    expect(results.at(-1)!.eligible).toBe(false);
  });
});
