import { Contract, Signer, providers } from "ethers";
import { ChainId, ChainName, coalesceChainId, getSignedVAAHash } from "../utils";
import { arrayify, zeroPad } from "ethers/lib/utils";
import WormholeTokenBridgeABI from "../../abi/WormholeTokenBridge.json";

export interface WormholeWrappedInfo {
  isWrapped: boolean;
  chainId: ChainId;
  assetAddress: Uint8Array;
}

export async function getIsWrappedAssetEth(
  tokenBridgeAddress: string,
  provider: Signer | providers.Provider,
  assetAddress: string,
): Promise<boolean> {
  if (!assetAddress) return false;
  const tokenBridge = new Contract(tokenBridgeAddress, WormholeTokenBridgeABI, provider);
  return await tokenBridge.isWrappedAsset(assetAddress);
}

export async function getForeignAssetEth(
  tokenBridgeAddress: string,
  provider: Signer | providers.Provider,
  originChain: ChainId | ChainName,
  originAsset: Uint8Array,
): Promise<string | null> {
  const tokenBridge = new Contract(tokenBridgeAddress, WormholeTokenBridgeABI, provider);
  try {
    return await tokenBridge.wrappedAsset(coalesceChainId(originChain), originAsset);
  } catch (e) {
    return null;
  }
}

export async function getOriginalAssetEth(
  tokenBridgeAddress: string,
  provider: Signer | providers.Provider,
  wrappedAddress: string,
  lookupChain: ChainId | ChainName,
): Promise<WormholeWrappedInfo> {
  const isWrapped = await getIsWrappedAssetEth(tokenBridgeAddress, provider, wrappedAddress);
  if (isWrapped) {
    const token = new Contract(wrappedAddress, WormholeTokenBridgeABI, provider);
    const chainId = (await token.chainId()) as ChainId; // origin chain
    const assetAddress = await token.nativeContract(); // origin address
    return {
      isWrapped: true,
      chainId,
      assetAddress: arrayify(assetAddress),
    };
  }
  return {
    isWrapped: false,
    chainId: coalesceChainId(lookupChain),
    assetAddress: zeroPad(arrayify(wrappedAddress), 32),
  };
}

export async function getIsTransferCompletedEth(
  tokenBridgeAddress: string,
  provider: Signer | providers.Provider,
  signedVAA: Uint8Array,
): Promise<boolean> {
  const tokenBridge = new Contract(tokenBridgeAddress, WormholeTokenBridgeABI, provider);
  const signedVAAHash = getSignedVAAHash(signedVAA);
  return await tokenBridge.isTransferCompleted(signedVAAHash);
}
