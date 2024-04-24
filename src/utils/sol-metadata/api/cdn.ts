import { PublicKey } from '@solana/web3.js';
import axios from 'axios';

import { UtlConfig } from '../config/utl-config';
import { Token, UTLCdnTokenList } from '../types';
import { publicKeysToMap } from '../utils';

const downloadTokenlist = async (cdnUrl: string): Promise<UTLCdnTokenList | null> => {
  try {
    const { data } = await axios.get<UTLCdnTokenList>(cdnUrl);
    return data;
  } catch {
    return null;
  }
};

export const fetchTokensCdn = async ({ cdnUrl }: UtlConfig, mints: PublicKey[]): Promise<Token[]> => {
  const tokenlist = await downloadTokenlist(cdnUrl);
  const mintsMap = publicKeysToMap(mints);

  return tokenlist?.tokens.filter((token) => mintsMap[token.address]) ?? [];
};
