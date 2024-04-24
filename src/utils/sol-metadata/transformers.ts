import { JsonMetadata, Option } from '@metaplex-foundation/js';

import { Token } from './types';

export interface TransformMetaplexData {
  name: string;
  symbol: string;
  image: string;
  mintAddress: string;
  decimals: number;
  uri?: string;
  json?: Option<JsonMetadata>;
}

export const transformMetaplexToken = (data: TransformMetaplexData, additionalData: object): Token => {
  const { name, symbol, mintAddress, decimals, uri, json } = data;
  return {
    name,
    symbol,
    logoURI: json?.image,
    address: mintAddress,
    decimals,
    uri,
    json,
    ...additionalData,
  };
};
