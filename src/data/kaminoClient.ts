/** Solana RPC + Kamino SDK handles. Simulation-only, no keypair. */
import { KaminoManager, KaminoVault } from '@kamino-finance/klend-sdk';
import { address, createSolanaRpc } from '@solana/kit';
import type { Config } from '../config.js';

const DEFAULT_SLOT_DURATION_MS = 400;

type SdkRpc = ConstructorParameters<typeof KaminoVault>[0];

export interface PinnedVault {
  /** Stable short label for logs, e.g. "v1". */
  id: string;
  address: string;
  vault: KaminoVault;
}

export class KaminoClient {
  private constructor(
    readonly rpc: SdkRpc,
    readonly manager: KaminoManager,
    readonly vaults: PinnedVault[],
  ) {}

  static async create(cfg: Config): Promise<KaminoClient> {
    const rpc = createSolanaRpc(cfg.rpcUrl);
    const manager = new KaminoManager(rpc, DEFAULT_SLOT_DURATION_MS);

    const vaults: PinnedVault[] = cfg.pinnedVaults.map((addr, idx) => ({
      id: `v${idx + 1}`,
      address: addr,
      vault: new KaminoVault(rpc, address(addr)),
    }));

    return new KaminoClient(rpc, manager, vaults);
  }

  async currentSlot(): Promise<bigint> {
    return this.rpc.getSlot().send();
  }
}
