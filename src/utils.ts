import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const wrapSolInstructions = ({
  payer,
  owner,
  lamports,
}: {
  payer: PublicKey;
  owner: PublicKey;
  lamports: number;
}): TransactionInstruction[] => {
  const nativeAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);

  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, nativeAta, owner, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: nativeAta,
      lamports,
    }),
    createSyncNativeInstruction(nativeAta),
  ];
};
