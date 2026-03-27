import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

type Schema = { wallets: { pub: string; secret: string }[] };
const adapter = new JSONFile<Schema>('db.json');
const db = new Low(adapter, { wallets: [] });
await db.read();

export const saveWallets = (wallets: Keypair[]) => {
  db.data.wallets = wallets.map((k) => ({
    pub: k.publicKey.toString(),
    secret: bs58.encode(k.secretKey),
  }));
  return db.write();
};

export const loadWallets = (): Keypair[] =>
  db.data.wallets.map((k) => Keypair.fromSecretKey(bs58.decode(k.secret)));