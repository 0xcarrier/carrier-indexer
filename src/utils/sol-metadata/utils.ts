import { PublicKey } from '@solana/web3.js';

export function publicKeysToMap(keys: PublicKey[]) {
  return keys.reduce((acc, cur) => {
    acc[cur.toString()] = true;
    return acc;
  }, {} as { [key: string]: boolean });
}
