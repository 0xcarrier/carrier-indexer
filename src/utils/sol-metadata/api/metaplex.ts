import { JsonMetadata, Metadata, Metaplex } from '@metaplex-foundation/js';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';

import { UtlConfig } from '../config/utl-config';
import { TransformMetaplexData, transformMetaplexToken } from '../transformers';
import { Token } from '../types';

const getNftMetadata = async (connection: Connection, mints: PublicKey[]): Promise<TransformMetaplexData[]> => {
  const metaplex = new Metaplex(connection);
  const tokens = await metaplex.nfts().findAllByMintList({ mints });

  const rawMetadatas = tokens.filter((item) => item != null && item.model === 'metadata') as Metadata<
    JsonMetadata<string>
  >[];

  const rawMetadatasParsedAccounts = await connection.getMultipleParsedAccounts(
    rawMetadatas.map((item) => item.mintAddress),
  );

  const rawMetadatasParsedAccountWithMintKeys = rawMetadatasParsedAccounts.value
    .map((item, index) => {
      const data = item && item.data && 'parsed' in item.data ? item.data.parsed : undefined;

      return data
        ? {
            mintKey: rawMetadatas[index].mintAddress,
            data,
          }
        : undefined;
    })
    .filter((item) => item != null) as { mintKey: PublicKey; data: any }[];

  const tokensWithoutJson = tokens.filter(
    (item) => item != null && !item.jsonLoaded && !item.json && item.uri,
  ) as Metadata<JsonMetadata<string>>[];

  const jsonPromises = tokensWithoutJson.map((item) => {
    return new Promise<{ mintKey: PublicKey; data: JsonMetadata<string> } | undefined>((resolve) => {
      axios
        .get<JsonMetadata<string>>(item.uri)
        .then((respond) => {
          resolve({ mintKey: item.mintAddress, data: respond.data });
        })
        .catch(() => {
          resolve(undefined);
        });
    });
  });

  const jsons = await Promise.all(jsonPromises);
  const jsonsNotEmpty = jsons.filter((item) => item != null) as {
    mintKey: PublicKey;
    data: JsonMetadata<string>;
  }[];

  const parsedTokens: TransformMetaplexData[] = tokens
    .map((token) => {
      if (token) {
        if (token.model === 'metadata') {
          const parsedAccount = rawMetadatasParsedAccountWithMintKeys.find(
            (item) => item.mintKey.toBase58() === token.mintAddress.toBase58(),
          );
          const json = jsonsNotEmpty.find((item) => item.mintKey.toBase58() === token.mintAddress.toBase58());
          return {
            name: token.name,
            symbol: token.symbol,
            image: json?.data.image || '',
            mintAddress: token.mintAddress.toString(),
            decimals: parsedAccount ? parsedAccount.data.info.decimals : 6,
            uri: token.uri,
            json: json?.data,
          };
        } else if (token.model === 'nft' || token.model === 'sft') {
          const parsedAccount = rawMetadatasParsedAccountWithMintKeys.find(
            (item) => item.mintKey.toBase58() === token.mint.address.toBase58(),
          );
          const json = jsonsNotEmpty.find((item) => item.mintKey.toBase58() === token.mint.address.toBase58());
          return {
            name: token.name,
            symbol: token.symbol,
            image: json?.data.image || '',
            mintAddress: token.mint.address.toString(),
            decimals: parsedAccount ? parsedAccount.data.info.decimals : 6,
            uri: token.uri,
            json: json?.data,
          };
        }
      }

      return null;
    })
    .filter((item) => item != null) as TransformMetaplexData[];

  return parsedTokens;
};

export const fetchTokensMetaplex = async ({ connection, chainId }: UtlConfig, mints: PublicKey[]): Promise<Token[]> => {
  const tokens = await getNftMetadata(connection, mints);

  return tokens.map((token) => {
    return transformMetaplexToken(token, {
      chainId,
      verified: false,
      source: 'METAPLEX',
    });
  });
};
