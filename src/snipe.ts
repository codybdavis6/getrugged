import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { JitoBundle } from './jito.js';
import { Liquidity, type LiquidityPoolKeys } from './raydium.js';

export const snipe = async (
  conn: Connection,
  wallets: Keypair[],
  poolKeys: LiquidityPoolKeys,
  mint: PublicKey,
) => {
  const buyingBaseMint = poolKeys.baseMint.equals(mint);
  const inputMint = buyingBaseMint ? poolKeys.quoteMint : poolKeys.baseMint;
  const inputDecimals = buyingBaseMint ? poolKeys.quoteDecimals : poolKeys.baseDecimals;
  const blockhash = await conn.getLatestBlockhash();

  const txs = wallets.map((wallet) => {
    const uiAmountIn = 0.9 + Math.random() * 0.19;
    const rawAmountIn = Math.round(uiAmountIn * 10 ** inputDecimals);
    const tokenAccountIn = getAssociatedTokenAddressSync(inputMint, wallet.publicKey);
    const tokenAccountOut = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const setupInstruction = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      tokenAccountOut,
      wallet.publicKey,
      mint,
    );
    const swap = Liquidity.makeSwapInstruction({
      poolKeys,
      userKeys: {
        tokenAccountIn,
        tokenAccountOut,
        owner: wallet.publicKey,
      },
      amountIn: rawAmountIn,
      amountOut: 0,
      fixedSide: 'in',
    });
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [setupInstruction, ...swap.innerTransaction.instructions],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    return tx;
  });

  const bundle = new JitoBundle(txs.map((tx) => tx.serialize()));
  return bundle.send();
};
