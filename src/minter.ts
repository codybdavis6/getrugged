import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { LiquidityPoolKeys, TokenAccount } from './raydium.js';
import {
  buildSimpleTransaction,
  Liquidity,
  MAINNET_PROGRAM_ID,
  MarketV2,
  SPL_ACCOUNT_LAYOUT,
  TxVersion,
} from './raydium.js';

const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_TOKENS_IN_LP = 1_000;
const DEFAULT_SOL_IN_LP = 0.5;
const DEFAULT_MARKET_LOT_SIZE = 1;
const DEFAULT_MARKET_TICK_SIZE = 0.000001;

const getNumberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
};

const sendLegacyTransactions = async (conn: Connection, payer: Keypair, transactions: Transaction[]) => {
  const signatures: string[] = [];

  for (const tx of transactions) {
    tx.partialSign(payer);
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction(signature, 'confirmed');
    signatures.push(signature);
  }

  return signatures;
};

const buildAndSendRaydiumTransactions = async (
  conn: Connection,
  payer: Keypair,
  innerTransactions: Parameters<typeof buildSimpleTransaction>[0]['innerTransactions'],
) => {
  const transactions = (await buildSimpleTransaction({
    connection: conn,
    makeTxVersion: TxVersion.LEGACY,
    payer: payer.publicKey,
    innerTransactions,
  })) as Transaction[];

  return sendLegacyTransactions(conn, payer, transactions);
};

const loadTokenAccount = async (
  conn: Connection,
  pubkey: PublicKey,
  programId = TOKEN_PROGRAM_ID,
): Promise<TokenAccount> => {
  const accountInfo = await conn.getAccountInfo(pubkey, 'confirmed');
  if (!accountInfo) {
    throw new Error(`Token account not found: ${pubkey.toBase58()}`);
  }

  return {
    programId,
    pubkey,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(accountInfo.data),
  };
};

export const createMarketAndPool = async (
  conn: Connection,
  payer: Keypair,
): Promise<{ mint: PublicKey; poolKeys: LiquidityPoolKeys }> => {
  const tokenDecimals = getNumberEnv('TOKEN_DECIMALS', DEFAULT_TOKEN_DECIMALS);
  const tokensInLp = getNumberEnv('TOKENS_IN_LP', DEFAULT_TOKENS_IN_LP);
  const solInLp = getNumberEnv('SOL_IN_LP', DEFAULT_SOL_IN_LP);
  const marketLotSize = getNumberEnv('MARKET_LOT_SIZE', DEFAULT_MARKET_LOT_SIZE);
  const marketTickSize = getNumberEnv('MARKET_TICK_SIZE', DEFAULT_MARKET_TICK_SIZE);

  const mint = Keypair.generate();
  const payerTokenAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey);
  const baseAmountRaw = BigInt(Math.round(tokensInLp * 10 ** tokenDecimals));
  const quoteAmountRaw = BigInt(Math.round(solInLp * LAMPORTS_PER_SOL));

  const mintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, tokenDecimals, payer.publicKey, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      payerTokenAta,
      payer.publicKey,
      mint.publicKey,
    ),
    createMintToInstruction(mint.publicKey, payerTokenAta, payer.publicKey, baseAmountRaw, [], TOKEN_PROGRAM_ID),
  );

  await sendAndConfirmTransaction(conn, mintTx, [payer, mint], { commitment: 'confirmed' });

  const market = await MarketV2.makeCreateMarketInstructionSimple({
    connection: conn,
    wallet: payer.publicKey,
    baseInfo: {
      mint: mint.publicKey,
      decimals: tokenDecimals,
    },
    quoteInfo: {
      mint: NATIVE_MINT,
      decimals: 9,
    },
    lotSize: marketLotSize,
    tickSize: marketTickSize,
    dexProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
    makeTxVersion: TxVersion.LEGACY,
  });

  await buildAndSendRaydiumTransactions(conn, payer, market.innerTransactions);

  const ownerTokenAccounts = [await loadTokenAccount(conn, payerTokenAta)];
  const startTime = BigInt(Math.floor(Date.now() / 1000));

  const pool = await Liquidity.makeCreatePoolV4InstructionV2Simple({
    connection: conn,
    programId: MAINNET_PROGRAM_ID.AmmV4,
    marketInfo: {
      marketId: market.address.marketId,
      programId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
    },
    baseMintInfo: {
      mint: mint.publicKey,
      decimals: tokenDecimals,
    },
    quoteMintInfo: {
      mint: NATIVE_MINT,
      decimals: 9,
    },
    baseAmount: baseAmountRaw,
    quoteAmount: quoteAmountRaw,
    startTime,
    ownerInfo: {
      feePayer: payer.publicKey,
      wallet: payer.publicKey,
      tokenAccounts: ownerTokenAccounts,
      useSOLBalance: true,
    },
    associatedOnly: true,
    checkCreateATAOwner: false,
    makeTxVersion: TxVersion.LEGACY,
  });

  await buildAndSendRaydiumTransactions(conn, payer, pool.innerTransactions);

  const derivedPoolKeys = Liquidity.getAssociatedPoolKeys({
    version: 4,
    marketVersion: 3,
    marketId: market.address.marketId,
    baseMint: mint.publicKey,
    quoteMint: NATIVE_MINT,
    baseDecimals: tokenDecimals,
    quoteDecimals: 9,
    programId: MAINNET_PROGRAM_ID.AmmV4,
    marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
  });

  const poolKeys: LiquidityPoolKeys = {
    ...derivedPoolKeys,
    marketBaseVault: market.address.baseVault,
    marketQuoteVault: market.address.quoteVault,
    marketBids: market.address.bids,
    marketAsks: market.address.asks,
    marketEventQueue: market.address.eventQueue,
  };

  return { mint: mint.publicKey, poolKeys };
};
