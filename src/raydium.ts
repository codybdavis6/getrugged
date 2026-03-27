import { createRequire } from 'node:module';
import type {
  LiquidityPoolKeys as LiquidityPoolKeysType,
  TokenAccount as TokenAccountType,
} from '@raydium-io/raydium-sdk';

const require = createRequire(import.meta.url);
const raydium = require('@raydium-io/raydium-sdk') as typeof import('@raydium-io/raydium-sdk');

export const Liquidity = raydium.Liquidity;
export const MarketV2 = raydium.MarketV2;
export const MAINNET_PROGRAM_ID = raydium.MAINNET_PROGRAM_ID;
export const TxVersion = raydium.TxVersion;
export const buildSimpleTransaction = raydium.buildSimpleTransaction;
export const SPL_ACCOUNT_LAYOUT = raydium.SPL_ACCOUNT_LAYOUT;
export const MARKET_STATE_LAYOUT_V2 = raydium.MARKET_STATE_LAYOUT_V2;
export type LiquidityPoolKeys = LiquidityPoolKeysType;
export type TokenAccount = TokenAccountType;
