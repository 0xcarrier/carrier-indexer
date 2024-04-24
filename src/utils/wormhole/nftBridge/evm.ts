import { BigNumber, Contract, Signer, providers } from "ethers";
import { CHAIN_ID_SOLANA, ChainId, ChainName, coalesceChainId } from "../utils";
import { arrayify, zeroPad } from "ethers/lib/utils";
import WormholeNftBridgeABI from "../../abi/WormholeNFTBridge.json";
import WormholeTokenBridgeABI from "../../abi/WormholeTokenBridge.json";

export async function getNftForeignAssetEth(
  nftBridgeAddress: string,
  provider: Signer | providers.Provider,
  originChain: ChainId | ChainName,
  originAsset: Uint8Array,
): Promise<string | null> {
  const originChainId = coalesceChainId(originChain);
  const tokenBridge = new Contract(nftBridgeAddress, WormholeNftBridgeABI, provider);
  try {
    if (originChainId === CHAIN_ID_SOLANA) {
      // All NFTs from Solana are minted to the same address, the originAsset is encoded as the tokenId as
      // BigNumber.from(new PublicKey(originAsset).toBytes()).toString()
      const addr = await tokenBridge.wrappedAsset(
        originChain,
        "0x0101010101010101010101010101010101010101010101010101010101010101",
      );
      return addr;
    }
    return await tokenBridge.wrappedAsset(originChainId, originAsset);
  } catch (e) {
    return null;
  }
}

export async function getIsNftWrappedAssetEth(
  nftBridgeAddress: string,
  provider: Signer | providers.Provider,
  assetAddress: string,
) {
  if (!assetAddress) return false;
  const tokenBridge = new Contract(nftBridgeAddress, WormholeNftBridgeABI, provider);
  return await tokenBridge.isWrappedAsset(assetAddress);
}

export interface WormholeWrappedNFTInfo {
  isWrapped: boolean;
  chainId: ChainId;
  assetAddress: Uint8Array;
  tokenId?: string;
}

export async function getOriginalNftAssetEth(
  nftBridgeAddress: string,
  provider: Signer | providers.Provider,
  wrappedAddress: string,
  tokenId: string,
  lookupChain: ChainId | ChainName,
): Promise<WormholeWrappedNFTInfo> {
  const isWrapped = await getIsNftWrappedAssetEth(nftBridgeAddress, provider, wrappedAddress);
  if (isWrapped) {
    const token = new Contract(wrappedAddress, WormholeTokenBridgeABI, provider);
    const chainId = (await token.chainId()) as ChainId; // origin chain
    const assetAddress = await token.nativeContract(); // origin address
    return {
      isWrapped: true,
      chainId,
      assetAddress: chainId === CHAIN_ID_SOLANA ? arrayify(BigNumber.from(tokenId)) : arrayify(assetAddress),
      tokenId, // tokenIds are maintained across EVM chains
    };
  }
  return {
    isWrapped: false,
    chainId: coalesceChainId(lookupChain),
    assetAddress: zeroPad(arrayify(wrappedAddress), 32),
    tokenId,
  };
}
