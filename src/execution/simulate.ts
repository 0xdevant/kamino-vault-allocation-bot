/**
 * Build real SDK ixs and run `simulateTransaction` against mainnet RPC.
 * `sigVerify:false` + a placeholder fee-payer means no key is ever required.
 */
import { address } from '@solana/kit';
import { noopSigner } from '@kamino-finance/klend-sdk/dist/utils/signer.js';
import type { Logger } from '../logger.js';
import type { RebalanceAction } from '../types.js';
import type { KaminoClient } from '../data/kaminoClient.js';
import { actionAmount } from './plan.js';
import { buildActionIxs } from './buildIxs.js';
import { simulateInstructions } from './tx.js';

const PLACEHOLDER_FEE_PAYER = '11111111111111111111111111111112';

export async function simulatePlan(
  client: KaminoClient,
  log: Logger,
  actions: RebalanceAction[],
): Promise<void> {
  if (actions.length === 0) {
    log.info('execute.noop', { note: 'HOLD — nothing to do' });
    return;
  }

  for (const action of actions) {
    log.info('execute.action', {
      kind: action.kind,
      vault: action.vaultId,
      amount: actionAmount(action),
      reason: action.reason,
    });
  }

  const feePayer = address(PLACEHOLDER_FEE_PAYER);
  const user = noopSigner(feePayer);
  const slot = await client.currentSlot();

  for (const action of actions) {
    const pv = client.vaults.find((vault) => vault.id === action.vaultId);
    if (!pv) continue;
    try {
      const ixs = await buildActionIxs(client.manager, pv, action, user, slot);
      const sim = (await simulateInstructions(
        client.rpc,
        feePayer,
        ixs,
      )) as { value?: { err?: unknown; unitsConsumed?: bigint; logs?: string[] } };
      // Placeholder fee-payer means err is ~always set (Custom:1 token-program
      // insufficient funds) — expected noise. Keep visible only at debug level.
      log.debug('execute.simulated', {
        kind: action.kind,
        vault: action.vaultId,
        instructionCount: ixs.length,
        err: sim.value?.err ?? null,
        unitsConsumed: sim.value?.unitsConsumed?.toString(),
      });
    } catch (err) {
      log.warn('execute.simulate.error', {
        vault: action.vaultId,
        kind: action.kind,
        err: (err as Error).message,
        note: 'Instruction build/simulation failed — see message; no funds touched.',
      });
    }
  }
}
