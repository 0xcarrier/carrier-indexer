import {
  ChainId,
  CHAIN_ID_SOLANA,
  getForeignAssetEth,
  getForeignAssetSolana,
  hexToUint8Array,
  isEVMChain,
  tryNativeToHexString,
  TokenBridgePayload,
  tryHexToNativeString,
  tryUint8ArrayToNative,
  uint8ArrayToHex,
  NftBridgePayload,
  getNftForeignAssetEth,
  getNftForeignAssetSol,
} from "../utils/wormhole";
import {
  getChainIdsList,
  getChainInfoFromWormholeChain,
  getEVMProviderWithWormholeChain,
  getTBTCAddressForChain,
  Polkachain,
  WORMHOLE_RPC_HOSTS,
} from "../bridge";
import { arrayify, stripZeros } from "ethers/lib/utils";
import { BigNumber, Contract, ethers } from "ethers";
import { IToken } from "../database/tokenModel";
import { Provider } from "@ethersproject/abstract-provider";
import ERC20ABI from "./abi/ERC20.json";
import ERC721ABI from "./abi/ERC721.json";
import { constructSolanaConnection } from "./solana";
import { getCCTPNetworkConfigs } from "./cctp";

export const supportedChains = getChainIdsList();

export async function getERC721Info(provider: Provider, tokenAddress: string, chainId?: ChainId) {
  if (tokenAddress === ethers.constants.AddressZero) {
    return;
  }

  try {
    const erc721 = new ethers.Contract(tokenAddress, ERC721ABI, provider);
    const name = await erc721.name();
    const symbol = await erc721.symbol();

    return chainId
      ? ({
          tokenAddress: tokenAddress,
          name: name || "",
          symbol: symbol || "",
          chainId: chainId,
        } as IToken)
      : ({
          tokenAddress: tokenAddress,
          name: name || "",
          symbol: symbol || "",
        } as IToken);
  } catch (e) {
    console.log("error: ", e);
  }
}

export async function getERC20Info(provider: Provider, tokenAddress: string, chainId?: ChainId) {
  if (tokenAddress === ethers.constants.AddressZero) {
    return;
  }
  try {
    const erc20 = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const name = await erc20.name();
    const symbol = await erc20.symbol();
    const decimals = await erc20.decimals();

    return chainId
      ? ({
          tokenAddress: tokenAddress.toLowerCase(),
          name: name || "",
          symbol: symbol || "",
          decimals: decimals || 0,
          chainId: chainId,
        } as IToken)
      : ({
          tokenAddress: tokenAddress.toLowerCase(),
          name: name || "",
          symbol: symbol || "",
          decimals: decimals || 0,
        } as IToken);
  } catch (e) {
    console.log("error: ", e);
  }
}

export function isChainSupported(chainId: ChainId) {
  return supportedChains.includes(chainId);
}

export function fetchForeignAsset(
  originAsset: string,
  originChain: ChainId,
  foreignChain: ChainId,
  nft?: boolean,
  originTokenId?: string,
) {
  if (!isChainSupported(foreignChain as ChainId)) {
    console.error("chain not supported: ", foreignChain);
    return null;
  }

  if (originChain === foreignChain) {
    return null;
  }

  const cctpConfigs = getCCTPNetworkConfigs({ sourceChainId: originChain, targetChainId: foreignChain });
  const tbtcAddressOnOriginChain = getTBTCAddressForChain(originChain);
  const tbtcAddressOnTargetChain = getTBTCAddressForChain(foreignChain);
  const originAssetHex = convertOriginAsset(originAsset, originChain);
  const originAssetBytes = hexToUint8Array(originAssetHex);
  const chainInfo = getChainInfoFromWormholeChain(foreignChain);
  const { wormholeNFTBridge, wormholeTokenBridge, chainId } = chainInfo;

  if (isEVMChain(foreignChain)) {
    const provider = getEVMProviderWithWormholeChain(chainId);

    if (!provider) {
      return null;
    }

    return nft
      ? getNftForeignAssetEth(wormholeNFTBridge, provider, originChain, originAssetBytes)
      : cctpConfigs &&
        cctpConfigs.cctpSourceNetworkConfigs.usdcContractAddress.toLowerCase() === originAsset.toLowerCase()
      ? cctpConfigs.cctpTargetNetworkConfigs.usdcContractAddress
      : tbtcAddressOnOriginChain &&
        tbtcAddressOnTargetChain &&
        tbtcAddressOnOriginChain.toLowerCase() === originAsset.toLowerCase()
      ? tbtcAddressOnTargetChain
      : getForeignAssetEth(wormholeTokenBridge, provider, originChain, originAssetBytes);
  } else if (foreignChain === CHAIN_ID_SOLANA) {
    const connection = constructSolanaConnection("confirmed");
    // assume origin token id can be found?)
    return nft
      ? getNftForeignAssetSol(
          wormholeNFTBridge,
          originChain,
          originAssetBytes,
          arrayify(BigNumber.from(originTokenId || "0")),
        )
      : tbtcAddressOnOriginChain &&
        tbtcAddressOnTargetChain &&
        tbtcAddressOnOriginChain.toLowerCase() === originAsset.toLowerCase()
      ? tbtcAddressOnTargetChain
      : getForeignAssetSolana(connection, wormholeTokenBridge, originChain, originAssetBytes);
  }
}

function convertOriginAsset(originAsset: string, originChain: ChainId) {
  try {
    return tryNativeToHexString(originAsset, originChain);
  } catch (e) {
    return originAsset;
  }
}

async function fetchVaa(options: { wormholeHost: string; chainId: number; emitterAddress: string; sequence: string }) {
  const { wormholeHost, chainId, emitterAddress, sequence } = options;
  // try polling from a list of wormhole guardian networks
  const response = await fetch(`${wormholeHost}/v1/signed_vaa/${chainId}/${emitterAddress}/${sequence}`);

  if (response.status === 200) {
    const signedVaa = await response.json();

    return signedVaa;
  } else if (response.status === 404) {
    return;
  } else {
    throw new Error(`fetchVaa response with status: ${response.status}`);
  }
}

export interface SignedVaaResult {
  vaaBytes: string;
}

export async function fetchVaaFromWormholeRpcHosts(options: {
  chainId: number;
  emitterAddress: string;
  sequence: string;
}): Promise<SignedVaaResult | undefined> {
  const { chainId, emitterAddress, sequence } = options;

  // try polling from a list of wormhole guardian networks
  for (let i = 0; i < WORMHOLE_RPC_HOSTS.length; i++) {
    const rpcHost = WORMHOLE_RPC_HOSTS[i];

    try {
      const signedVaa = await fetchVaa({ wormholeHost: rpcHost, chainId, emitterAddress, sequence });

      return signedVaa;
    } catch (e) {
      console.log("fetchVaa error", e);
      continue;
    }
  }

  return undefined;
}

function getConsoleLogWithTimestamp(self: (...args: any[]) => void) {
  return (...args: any[]) => {
    const now = new Date().toISOString();

    if (args.length && typeof args[0] === "string" && args[0].includes("%s")) {
      const [formatter, ...rest] = args;

      self(`[${now}] ${formatter}`, ...rest);
    } else {
      self(`[${now}]`, ...args);
    }
  };
}

export function appendTimestampToLog() {
  console.log = getConsoleLogWithTimestamp(console.log);
  console.error = getConsoleLogWithTimestamp(console.error);
  console.warn = getConsoleLogWithTimestamp(console.warn);
  console.info = getConsoleLogWithTimestamp(console.info);

  process.on("uncaughtException", function (e) {
    console.log(e.stack || e);
    process.exit(1);
  });
}

export const timeoutPromise = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sleepPromise(ms: number) {
  if (ms > 0) {
    await timeoutPromise(ms);
  }
}

export function isCarrierPolkaChain(chainId?: Polkachain) {
  if (
    chainId === Polkachain.Polkadot ||
    chainId === Polkachain.Acala ||
    chainId === Polkachain.HydraDX ||
    chainId === Polkachain.PeaqAgung ||
    chainId === Polkachain.Moonbeam ||
    chainId === Polkachain.Phala ||
    chainId === Polkachain.Interlay ||
    chainId === Polkachain.MoonbaseAlpha ||
    chainId === Polkachain.Manta ||
    chainId === Polkachain.MoonbaseBeta
  ) {
    return true;
  } else {
    return false;
  }
}

export function convertPayloadToUint8Array(payload: string): Uint8Array {
  let payloadNoZeroHex = payload;

  if (payloadNoZeroHex.startsWith("0x")) {
    payloadNoZeroHex = payload.toString().slice(2);
  }

  return hexToUint8Array(payloadNoZeroHex);
}

export function tryRecipientAddressToNative(address: string | Buffer, chainId: ChainId) {
  // convert the hex address to native chain address format, e.g. solana address
  let recipientAddr = address;

  if (typeof recipientAddr === "string") {
    if (recipientAddr.startsWith("0x")) {
      recipientAddr = recipientAddr.slice(2);
    }
  }

  try {
    return typeof recipientAddr === "string"
      ? tryHexToNativeString(recipientAddr, chainId)
      : tryUint8ArrayToNative(recipientAddr, chainId);
  } catch (e) {
    // return original address which is in hex if error for some reasons
    return ethers.constants.AddressZero;
  }
}

export function normalizeHexAddress(address: string): string {
  // address is 0x with padded zeros
  // normalize it to human readable
  return `0x${uint8ArrayToHex(stripZeros(address))}`.toLowerCase();
}

export function isTokenTransferPayload(payload: Buffer) {
  const payloadType = payload.readUInt8(0);
  return payloadType == TokenBridgePayload.Transfer || payloadType == TokenBridgePayload.TransferWithPayload;
}

export function isNFTTransferPayload(payload: Buffer) {
  const payloadType = payload.readUInt8(0);
  return payloadType == NftBridgePayload.Transfer;
}
