import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { wrapSolInstructions } from './utils.js';

export const fundWallets = async (
  conn: Connection,
  payer: Keypair,
  wallets: Keypair[],
  amtSol = 0.02,
) => {
  const transferLamports = Math.round(amtSol * LAMPORTS_PER_SOL);
  const wrappedLamports = Math.floor(transferLamports * 0.9);
  const instructions = wallets.flatMap((wallet) => [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wallet.publicKey,
      lamports: transferLamports,
    }),
    ...wrapSolInstructions({
      payer: payer.publicKey,
      owner: wallet.publicKey,
      lamports: wrappedLamports,
    }),
  ]);

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
      instructions,
    }).compileToV0Message(),
  );

  tx.sign([payer, ...wallets]);

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
};
