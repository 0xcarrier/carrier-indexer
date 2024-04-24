import { BN } from "bn.js";
import { CHAIN_ID_SOLANA, ChainId, ChainName, coalesceChainId, deriveAddress, tryNativeToUint8Array } from "../utils";
import { PublicKey, PublicKeyInitData } from "@solana/web3.js";
import { isBytes } from "ethers/lib/utils";

export function deriveNftWrappedMintKey(
  tokenBridgeProgramId: PublicKeyInitData,
  tokenChain: number | ChainId,
  tokenAddress: Buffer | Uint8Array | string,
  tokenId: bigint | number,
): PublicKey {
  if (tokenChain == CHAIN_ID_SOLANA) {
    throw new Error("tokenChain == CHAIN_ID_SOLANA does not have wrapped mint key");
  }
  if (typeof tokenAddress == "string") {
    tokenAddress = tryNativeToUint8Array(tokenAddress, tokenChain as ChainId);
  }
  return deriveAddress(
    [
      Buffer.from("wrapped"),
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(tokenChain as number);
        return buf;
      })(),
      tokenAddress,
      new BN(tokenId.toString()).toArrayLike(Buffer, "be", 32),
    ],
    tokenBridgeProgramId,
  );
}

export async function getNftForeignAssetSol(
  nftBridgeAddress: PublicKeyInitData,
  originChain: ChainId | ChainName,
  originAsset: string | Uint8Array | Buffer,
  tokenId: Uint8Array | Buffer | bigint,
): Promise<string> {
  // we don't require NFT accounts to exist, so don't check them.
  return deriveNftWrappedMintKey(
    nftBridgeAddress,
    coalesceChainId(originChain) as number,
    originAsset,
    isBytes(tokenId) ? BigInt(new BN(tokenId).toString()) : tokenId,
  ).toString();
}

export function deriveNftEndpointKey(
  tokenBridgeProgramId: PublicKeyInitData,
  emitterChain: number | ChainId,
  emitterAddress: Buffer | Uint8Array | string,
): PublicKey {
  if (emitterChain == CHAIN_ID_SOLANA) {
    throw new Error("emitterChain == CHAIN_ID_SOLANA cannot exist as foreign token bridge emitter");
  }
  if (typeof emitterAddress == "string") {
    emitterAddress = tryNativeToUint8Array(emitterAddress, emitterChain as ChainId);
  }
  return deriveAddress(
    [
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(emitterChain as number);
        return buf;
      })(),
      emitterAddress,
    ],
    tokenBridgeProgramId,
  );
}

export class NftWrappedMeta {
  chain: number;
  tokenAddress: Buffer;
  tokenId: bigint;

  constructor(chain: number, tokenAddress: Buffer, tokenId: bigint) {
    this.chain = chain;
    this.tokenAddress = tokenAddress;
    this.tokenId = tokenId;
  }

  static deserialize(data: Buffer): NftWrappedMeta {
    if (data.length != 66) {
      throw new Error("data.length != 66");
    }
    const chain = data.readUInt16LE(0);
    const tokenAddress = data.subarray(2, 34);
    const tokenId = BigInt(new BN(data.subarray(34, 66), undefined, "le").toString());
    return new NftWrappedMeta(chain, tokenAddress, tokenId);
  }
}
