import { describe, expect, it, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { getBase58Decoder } from '@solana/kit';
import { PROGRAM_ID as KVAULT_PROGRAM_ID } from '@kamino-finance/klend-sdk/dist/@codegen/kvault/programId.js';
import {
  KVAULT_IX_TABLE,
  classifyKvaultDiscriminator,
  makeCuratorActionSignal,
} from '../src/risk/curatorAction.js';
import type { RiskConfig, VaultSnapshot } from '../src/types.js';

const bytes = (hexStr: string) =>
  new Uint8Array((hexStr.match(/../g) ?? []).map((byteStr) => parseInt(byteStr, 16)));

describe('curator-action discriminator classifier (pure)', () => {
  it('maps every dangerous kvault instruction to the right severity', () => {
    const sev = Object.fromEntries(KVAULT_IX_TABLE.map((entry) => [entry.name, entry.severity]));
    expect(sev.removeAllocation).toBe('block');
    expect(sev.updateAdmin).toBe('block');
    expect(sev.updateVaultConfig).toBe('warn');
    expect(sev.updateReserveAllocation).toBe('info');
    expect(sev.invest).toBe('info');
    expect(sev.withdrawPendingFees).toBe('info');
    expect(sev.giveUpPendingFees).toBe('info');
    expect(KVAULT_IX_TABLE).toHaveLength(7);
  });

  it('every discriminator is a real 8-byte Anchor discriminator from the SDK', () => {
    for (const entry of KVAULT_IX_TABLE) expect(entry.disc).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trips: each table discriminator classifies back to itself', () => {
    for (const entry of KVAULT_IX_TABLE) {
      const result = classifyKvaultDiscriminator(bytes(entry.disc));
      expect(result).toEqual({ name: entry.name, severity: entry.severity });
    }
  });

  it('matches only the first 8 bytes (ignores instruction args that follow)', () => {
    const withArgs = bytes(KVAULT_IX_TABLE[0]!.disc + 'deadbeefdeadbeef');
    expect(classifyKvaultDiscriminator(withArgs)?.name).toBe(KVAULT_IX_TABLE[0]!.name);
  });

  it('returns null for an unknown / benign instruction', () => {
    expect(classifyKvaultDiscriminator(bytes('0102030405060708'))).toBeNull();
  });
});

describe('curator-action persistence across ticks', () => {
  const VAULT_ADDR = 'So11111111111111111111111111111111111111112';
  const ADMIN = '11111111111111111111111111111111';
  const SIG = '4PxkTestUpdateReserveAllocSig';

  const updateReserveAllocDisc = KVAULT_IX_TABLE.find(
    (entry) => entry.name === 'updateReserveAllocation',
  )!.disc;
  const ixDataB58 = getBase58Decoder().decode(bytes(updateReserveAllocDisc));

  const snap = (id = 'v3'): VaultSnapshot => ({
    id,
    address: VAULT_ADDR,
    name: 'Test',
    asset: 'USDC',
    netApy: new Decimal(6),
    grossApy: new Decimal(6),
    apy90d: new Decimal(6),
    performanceFeeBps: 0,
    managementFeeBps: 0,
    aumUsd: new Decimal(1_000_000),
    sharesIssued: new Decimal(1),
    sharePrice: new Decimal(1),
    curator: ADMIN,
    allocationAdmin: ADMIN,
    reserves: [],
    weightedUtilization: new Decimal(0.9),
    utilizationTrend: new Decimal(0),
    timestamp: 0,
  });

  const cfg: RiskConfig = {
    minAumUsd: new Decimal(0),
    aumDropPct: 0,
    allocShiftPct: 0,
    maxSampleAgeMs: 0,
    maxUtilPct: 0,
    maxUtilPolls: 0,
  };

  const makeRpc = (blockTimeSec: number) => {
    const state = { txFetches: 0 };
    const rpc = {
      getSignaturesForAddress: () => ({
        send: async () => [{ signature: SIG, blockTime: blockTimeSec }],
      }),
      getTransaction: () => {
        state.txFetches += 1;
        return {
          send: async () => ({
            transaction: {
              message: {
                instructions: [
                  {
                    programId: String(KVAULT_PROGRAM_ID),
                    accounts: [VAULT_ADDR],
                    data: ixDataB58,
                  },
                ],
              },
            },
          }),
        };
      },
    };
    return { rpc, state };
  };

  it('re-emits the flag each tick within lookbackMs, then clears when expired', async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);

      const { rpc, state } = makeRpc(Math.floor(t0 / 1000) - 30);
      const signal = makeCuratorActionSignal({ rpc, lookbackMs: 900_000 });
      const input = { snapshots: [snap()], history: [], config: cfg };

      const tick1 = await signal.evaluate(input);
      expect(tick1).toHaveLength(1);
      expect(tick1[0]!.severity).toBe('info');
      expect(tick1[0]!.metric?.instruction).toBe('updateReserveAllocation');
      expect(state.txFetches).toBe(1);

      // Tick within lookback: same flag, no re-fetch.
      vi.setSystemTime(t0 + 60_000);
      const tick2 = await signal.evaluate(input);
      expect(tick2).toHaveLength(1);
      expect(tick2[0]!.severity).toBe('info');
      expect(state.txFetches).toBe(1);

      // Past lookback for the 30s-old tx (900_000ms window) → cleared.
      vi.setSystemTime(t0 + 900_000 + 30_000 + 1);
      const tick3 = await signal.evaluate(input);
      expect(tick3).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
