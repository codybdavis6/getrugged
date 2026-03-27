import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

export const genWallets = (n = 100): Keypair[] =>
  Array.from({ length: n }, (_, i) => {
    const seed = createHash('sha256').update(`getrugged:${i}`).digest();
    return Keypair.fromSeed(seed);
  });
