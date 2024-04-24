import { JsonMetadata, NftEdition, Option } from '@metaplex-foundation/js';

export enum Tag {
  LP_TOKEN = 'lp-token',
}

export enum ChainId {
  MAINNET = 101,
  TESTNET = 102,
  DEVNET = 103,
}

export interface Token {
  name: string;
  symbol: string;
  logoURI?: string;
  verified?: boolean;
  address: string;
  tags?: Set<Tag>;
  decimals: number;
  holders?: number;
  uri?: string;
  json?: Option<JsonMetadata>;
  edition?: NftEdition;
}

export interface UTLCdnTokenList {
  name: string;
  logoURI: string;
  keywords: string[];
  tags: Set<Tag>;
  timestamp: string;
  tokens: Token[];
}

export interface UTLApiResponse {
  content: Token[];
}

export interface SearchOptions {
  start: number;
  limit: number;
}
