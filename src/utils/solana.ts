import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { getSolanaUtilConfig } from "../cronjob/sync-solana";
import { Client } from "./sol-metadata";
import { CHAIN_ID_SOLANA } from "../utils/wormhole";
import { IToken } from "../database/tokenModel";
import { randomInt } from "crypto";
import { getBridgeChains } from "../bridge";

export async function getSolanaTokenInfo(connection: Connection, tokenAddress: string) {
  const config = getSolanaUtilConfig(connection);
  const utl = new Client(config);
  const mintKey = new PublicKey(tokenAddress);
  const token = await utl.fetchMint(mintKey);

  if (token) {
    return {
      tokenAddress: token.address,
      chainId: CHAIN_ID_SOLANA,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      updated: new Date(),
      created: new Date(),
    } as IToken;
  }
  return null;
}

const chains = getBridgeChains();
const { rpcUrls } = chains.SOLANA;

export function constructSolanaConnection(commitment?: Commitment) {
  const rpcUrl = rpcUrls[randomInt(0, rpcUrls.length)];

  return commitment ? new Connection(rpcUrl, commitment) : new Connection(rpcUrl);
}
