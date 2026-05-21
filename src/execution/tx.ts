/**
 * `simulateTransaction` with `sigVerify:false` + `replaceRecentBlockhash:true`,
 * so no key is required. Live broadcast is intentionally not implemented.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit';

type Ix = Instruction;
type AnyRpc = {
  getLatestBlockhash(): {
    send(): Promise<{ value: { blockhash: Blockhash; lastValidBlockHeight: bigint } }>;
  };
  simulateTransaction(tx: string, cfg: unknown): { send(): Promise<unknown> };
};

export async function simulateInstructions(
  rpc: AnyRpc,
  feePayer: Address,
  ixs: Ix[],
): Promise<unknown> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(feePayer, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstructions(ixs, msg),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  return rpc
    .simulateTransaction(wire, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();
}
