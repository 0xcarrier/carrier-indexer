import { AccountInfo, Commitment, Connection, PublicKey, PublicKeyInitData } from "@solana/web3.js";
import {
  CHAIN_ID_SOLANA,
  ChainId,
  ChainName,
  SignedVaa,
  coalesceChainId,
  deriveAddress,
  parseVaa,
  tryNativeToUint8Array,
} from "../utils";

export function deriveWormholeEmitterKey(emitterProgramId: PublicKeyInitData): PublicKey {
  return deriveAddress([Buffer.from("emitter")], emitterProgramId);
}

export function deriveWrappedMintKey(
  tokenBridgeProgramId: PublicKeyInitData,
  tokenChain: number | ChainId,
  tokenAddress: Buffer | Uint8Array | string,
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
    ],
    tokenBridgeProgramId,
  );
}

export async function getWrappedMeta(
  connection: Connection,
  tokenBridgeProgramId: PublicKeyInitData,
  mint: PublicKeyInitData,
  commitment?: Commitment,
): Promise<WrappedMeta> {
  return connection
    .getAccountInfo(deriveWrappedMetaKey(tokenBridgeProgramId, mint), commitment)
    .then((info) => WrappedMeta.deserialize(getAccountData(info)));
}

export async function getForeignAssetSolana(
  connection: Connection,
  tokenBridgeAddress: PublicKeyInitData,
  originChain: ChainId | ChainName,
  originAsset: Uint8Array,
  commitment?: Commitment,
): Promise<string | null> {
  const mint = deriveWrappedMintKey(tokenBridgeAddress, coalesceChainId(originChain) as number, originAsset);
  return getWrappedMeta(connection, tokenBridgeAddress, mint, commitment)
    .catch((_) => null)
    .then((meta) => (meta === null ? null : mint.toString()));
}

export function deriveEndpointKey(
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

export function deriveWrappedMetaKey(tokenBridgeProgramId: PublicKeyInitData, mint: PublicKeyInitData): PublicKey {
  return deriveAddress([Buffer.from("meta"), new PublicKey(mint).toBuffer()], tokenBridgeProgramId);
}

export class WrappedMeta {
  chain: number;
  tokenAddress: Buffer;
  originalDecimals: number;
  lastUpdatedSequence?: bigint;

  constructor(chain: number, tokenAddress: Buffer, originalDecimals: number, lastUpdatedSequence?: bigint) {
    this.chain = chain;
    this.tokenAddress = tokenAddress;
    this.originalDecimals = originalDecimals;
    this.lastUpdatedSequence = lastUpdatedSequence;
  }

  static deserialize(data: Buffer): WrappedMeta {
    if (data.length !== 35 && data.length !== 43) {
      throw new Error(`invalid wrapped meta length: ${data.length}`);
    }
    const chain = data.readUInt16LE(0);
    const tokenAddress = data.subarray(2, 34);
    const originalDecimals = data.readUInt8(34);
    const lastUpdatedSequence = data.length === 43 ? data.readBigUInt64LE(35) : undefined;
    return new WrappedMeta(chain, tokenAddress, originalDecimals, lastUpdatedSequence);
  }
}

export function deriveClaimKey(
  programId: PublicKeyInitData,
  emitterAddress: Buffer | Uint8Array | string,
  emitterChain: number,
  sequence: bigint | number,
): PublicKey {
  const address = typeof emitterAddress == "string" ? Buffer.from(emitterAddress, "hex") : Buffer.from(emitterAddress);
  if (address.length != 32) {
    throw Error("address.length != 32");
  }
  const sequenceSerialized = Buffer.alloc(8);
  sequenceSerialized.writeBigUInt64BE(typeof sequence == "number" ? BigInt(sequence) : sequence);
  return deriveAddress(
    [
      address,
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(emitterChain as number);
        return buf;
      })(),
      sequenceSerialized,
    ],
    programId,
  );
}

export function getAccountData(info: AccountInfo<Buffer> | null): Buffer {
  if (info === null) {
    throw Error("account info is null");
  }
  return info.data;
}

export async function getClaim(
  connection: Connection,
  programId: PublicKeyInitData,
  emitterAddress: Buffer | Uint8Array | string,
  emitterChain: number,
  sequence: bigint | number,
  commitment?: Commitment,
): Promise<boolean> {
  return connection
    .getAccountInfo(deriveClaimKey(programId, emitterAddress, emitterChain, sequence), commitment)
    .then((info) => !!getAccountData(info)[0]);
}

export async function getIsTransferCompletedSolana(
  tokenBridgeAddress: PublicKeyInitData,
  signedVAA: SignedVaa,
  connection: Connection,
  commitment?: Commitment,
): Promise<boolean> {
  const parsed = parseVaa(signedVAA);
  return getClaim(
    connection,
    tokenBridgeAddress,
    parsed.emitterAddress,
    parsed.emitterChain,
    parsed.sequence,
    commitment,
  ).catch((e) => false);
}
