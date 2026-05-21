/**
 * Cause-side signal: polls `getSignaturesForAddress` for vault admin pubkeys and
 * matches Anchor discriminators against dangerous kvault instructions. kvault
 * emits no events, so instruction-level inspection is the only option.
 *
 * Each classified signature stays in `cache` and is re-emitted every tick until
 * `now - blockTime > lookbackMs`, so a warn persists for its full window rather
 * than firing once and silently vanishing. Restart re-classifies once.
 */
import { address, getBase58Encoder } from '@solana/kit';
import * as ixRemoveAllocation from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/removeAllocation.js';
import * as ixUpdateAdmin from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/updateAdmin.js';
import * as ixUpdateReserveAllocation from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/updateReserveAllocation.js';
import * as ixUpdateVaultConfig from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/updateVaultConfig.js';
import * as ixInvest from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/invest.js';
import * as ixWithdrawPendingFees from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdrawPendingFees.js';
import * as ixGiveUpPendingFees from '@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/giveUpPendingFees.js';
import { PROGRAM_ID as KVAULT_PROGRAM_ID } from '@kamino-finance/klend-sdk/dist/@codegen/kvault/programId.js';
import type { RiskFlag, RiskSeverity, RiskSignal, RiskSignalInput } from '../types.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface KvaultIxClass {
  name: string;
  severity: RiskSeverity;
}
type DiscMod = { DISCRIMINATOR: Uint8Array };
// block: liquidity pull / control change. warn: config change. info: routine re-weight / keeper op.
// updateReserveAllocation is the normal cap-tuning path — drastic shifts surface effect-side via allocShift.
const SRC: { mod: DiscMod; name: string; severity: RiskSeverity }[] = [
  { mod: ixRemoveAllocation, name: 'removeAllocation', severity: 'block' },
  { mod: ixUpdateAdmin, name: 'updateAdmin', severity: 'block' },
  { mod: ixUpdateVaultConfig, name: 'updateVaultConfig', severity: 'warn' },
  { mod: ixUpdateReserveAllocation, name: 'updateReserveAllocation', severity: 'info' },
  { mod: ixInvest, name: 'invest', severity: 'info' },
  { mod: ixWithdrawPendingFees, name: 'withdrawPendingFees', severity: 'info' },
  { mod: ixGiveUpPendingFees, name: 'giveUpPendingFees', severity: 'info' },
];
const TABLE: { disc: string; name: string; severity: RiskSeverity }[] = SRC.map((entry) => ({
  disc: hex(entry.mod.DISCRIMINATOR),
  name: entry.name,
  severity: entry.severity,
}));

export function classifyKvaultDiscriminator(first8: Uint8Array): KvaultIxClass | null {
  const discHex = hex(first8.subarray(0, 8));
  const match = TABLE.find((row) => row.disc === discHex);
  return match ? { name: match.name, severity: match.severity } : null;
}

/** Exported for unit tests that pin every discriminator value. */
export const KVAULT_IX_TABLE = TABLE;

const KVAULT = String(KVAULT_PROGRAM_ID);
const b58 = getBase58Encoder();
const short = (pk: string) => (pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk);

export interface CuratorActionOptions {
  /** Structurally typed — avoids @solana/kit version-skew friction. */
  rpc: unknown;
  lookbackMs: number;
  /** getSignaturesForAddress page size per admin. */
  maxSigs?: number;
}

type WatchRpc = {
  getSignaturesForAddress: (
    addr: ReturnType<typeof address>,
    cfg: { limit: number },
  ) => { send: () => Promise<ReadonlyArray<{ signature: string; blockTime?: number | bigint | null }>> };
  getTransaction: (sig: string, cfg: Record<string, unknown>) => { send: () => Promise<unknown> };
};

interface CachedEntry {
  vaultId: string;
  severity: RiskSeverity;
  admin: string;
  instruction: string;
}

interface CacheRow {
  blockTimeMs: number;
  entries: CachedEntry[];
}

function classifyTx(
  tx: unknown,
  vaultAddrToId: Map<string, string>,
  admin: string,
): CachedEntry[] {
  const instrs =
    (tx as { transaction?: { message?: { instructions?: unknown[] } } })?.transaction
      ?.message?.instructions ?? [];
  const entries: CachedEntry[] = [];
  // (vaultId|ixName) — collapses multi-reserve fan-out into one entry.
  const dedup = new Set<string>();
  for (const raw of instrs) {
    const ix = raw as { programId?: string; accounts?: string[]; data?: string };
    if (String(ix.programId) !== KVAULT || !ix.data) continue;
    let cls: KvaultIxClass | null;
    try {
      cls = classifyKvaultDiscriminator(new Uint8Array(b58.encode(ix.data)));
    } catch {
      continue;
    }
    if (!cls) continue;
    for (const acct of ix.accounts ?? []) {
      const vaultId = vaultAddrToId.get(acct);
      if (!vaultId) continue;
      const dKey = `${vaultId}|${cls.name}`;
      if (dedup.has(dKey)) continue;
      dedup.add(dKey);
      entries.push({ vaultId, severity: cls.severity, admin, instruction: cls.name });
    }
  }
  return entries;
}

function makeFlag(entry: CachedEntry, sig: string, ageMs: number): RiskFlag {
  return {
    vaultId: entry.vaultId,
    signal: 'curator-action',
    severity: entry.severity,
    reason:
      `Admin ${short(entry.admin)} signed kvault \`${entry.instruction}\` ` +
      `${Math.round(ageMs / 1000)}s ago (tx ${short(sig)}) — ` +
      (entry.severity === 'block'
        ? 'liquidity pull / control change → exiting.'
        : entry.severity === 'warn'
          ? 'config change → trimming & watching.'
          : 'routine curator/keeper op → informational.'),
    metric: { instruction: entry.instruction, signer: entry.admin, signature: sig },
  };
}

export function makeCuratorActionSignal(opts: CuratorActionOptions): RiskSignal {
  const rpc = opts.rpc as WatchRpc;
  const maxSigs = opts.maxSigs ?? 20;
  const cache = new Map<string, CacheRow>();

  return {
    name: 'curator-action',
    async evaluate(input: RiskSignalInput): Promise<RiskFlag[]> {
      const now = Date.now();
      const admins = new Set<string>();
      const vaultAddrToId = new Map<string, string>();
      for (const snap of input.snapshots) {
        if (snap.curator) admins.add(snap.curator);
        if (snap.allocationAdmin) admins.add(snap.allocationAdmin);
        vaultAddrToId.set(snap.address, snap.id);
      }

      for (const admin of admins) {
        let sigs: ReadonlyArray<{ signature: string; blockTime?: number | bigint | null }>;
        try {
          sigs = await rpc.getSignaturesForAddress(address(admin), { limit: maxSigs }).send();
        } catch {
          continue;
        }
        for (const sigInfo of sigs) {
          if (cache.has(sigInfo.signature)) continue;
          const blockTimeMs =
            sigInfo.blockTime != null ? Number(sigInfo.blockTime) * 1000 : now;
          if (now - blockTimeMs > opts.lookbackMs) {
            // Outside window — record as known so we never re-fetch.
            cache.set(sigInfo.signature, { blockTimeMs, entries: [] });
            continue;
          }
          let tx: unknown;
          try {
            tx = await rpc
              .getTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
                encoding: 'jsonParsed',
                commitment: 'confirmed',
              })
              .send();
          } catch {
            continue;
          }
          cache.set(sigInfo.signature, {
            blockTimeMs,
            entries: classifyTx(tx, vaultAddrToId, admin),
          });
        }
      }

      // Drive emission from the cache so flags survive even if the sig pages
      // off the admin's recent-history window.
      const liveVaultIds = new Set(input.snapshots.map((snap) => snap.id));
      const flags: RiskFlag[] = [];
      for (const [sig, row] of cache) {
        const ageMs = now - row.blockTimeMs;
        if (ageMs > opts.lookbackMs) {
          cache.delete(sig);
          continue;
        }
        for (const entry of row.entries) {
          if (!liveVaultIds.has(entry.vaultId)) continue;
          flags.push(makeFlag(entry, sig, ageMs));
        }
      }
      return flags;
    },
  };
}
