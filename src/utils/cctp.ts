import {
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_AVAX,
  CHAIN_ID_BASE,
  CHAIN_ID_ETH,
  CHAIN_ID_OPTIMISM,
  CHAIN_ID_POLYGON,
  CHAIN_ID_SOLANA,
  ChainId,
  TokenBridgePayload,
  TokenTransfer,
} from "../utils/wormhole";
import { CCTPDomain, CCTPSdk, decodeMessage } from "@automata-network/cctp-sdk";
import { BigNumber, Contract, ethers } from "ethers";
import { BRIDGE, CLUSTER, getEVMProviderWithWormholeChain } from "../bridge";
import WormholeCCTPIntegrationABI from "./abi/WormholeCCTPIntegration.json";
import { solidityKeccak256 } from "ethers/lib/utils";
import { PublicKey } from "@solana/web3.js";

export const carrierChainIdCCTPDomainMap: { [chainId: number]: CCTPDomain } = {
  [CHAIN_ID_ETH]: CCTPDomain.Ethereum,
  [CHAIN_ID_AVAX]: CCTPDomain.Avalanche,
  [CHAIN_ID_ARBITRUM]: CCTPDomain.Arbitrum,
  [CHAIN_ID_OPTIMISM]: CCTPDomain.Optimism,
  [CHAIN_ID_BASE]: CCTPDomain.Base,
  [CHAIN_ID_POLYGON]: CCTPDomain.Polygon,
  [CHAIN_ID_SOLANA]: CCTPDomain.Solana,
};

export const cctpSDK =
  CLUSTER === "mainnet"
    ? CCTPSdk({
        mainnet: {
          networks: [
            {
              domain: CCTPDomain.Solana,
              usdcContractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              cctpMessageTransmitterContractAddress: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
              cctpMessengerContractAddress: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
              cctpMessageContractAddress: "",
              rpc: BRIDGE.MAINNET.SOLANA.rpcUrls[0],
            },
          ],
        },
      }).mainnet()
    : CCTPSdk().testnet();

export function isUSDCCanBeBridgeByCCTP(options: {
  sourceChainId: ChainId;
  targetChainId: ChainId;
  tokenAddress: string;
}) {
  const { sourceChainId, targetChainId, tokenAddress } = options;

  const sourceDomain = carrierChainIdCCTPDomainMap[sourceChainId];
  const sourceChainConfig = cctpSDK.configs.networks.find((item) => item.domain === sourceDomain);
  const targetDomain = carrierChainIdCCTPDomainMap[targetChainId];
  const targetChainConfig = cctpSDK.configs.networks.find((item) => item.domain === targetDomain);

  return sourceChainConfig && targetChainConfig
    ? sourceChainConfig.usdcContractAddress.toLowerCase() === tokenAddress.toLowerCase()
    : false;
}

export function getChainIdByDomain(domain: CCTPDomain) {
  const chainId = Object.keys(carrierChainIdCCTPDomainMap).find(
    (key) => carrierChainIdCCTPDomainMap[key as unknown as number] === domain,
  );

  if (!chainId) {
    throw new Error(`not a valid domain: ${domain}`);
  }

  return parseInt(chainId) as ChainId;
}

export function getCCTPNetworkConfigs(options: { sourceChainId: ChainId; targetChainId: ChainId }) {
  const { sourceChainId, targetChainId } = options;

  const cctpSourceNetworkConfigs = getCCTPNetworkConfigsByChainId({ chainId: sourceChainId });
  const cctpTargetNetworkConfigs = getCCTPNetworkConfigsByChainId({ chainId: targetChainId });

  return cctpSourceNetworkConfigs && cctpTargetNetworkConfigs
    ? { cctpSourceNetworkConfigs, cctpTargetNetworkConfigs }
    : undefined;
}

export function getCCTPNetworkConfigsByChainId(options: { chainId: ChainId }) {
  const { chainId } = options;
  const cctpDomain = carrierChainIdCCTPDomainMap[chainId];
  const cctpNetworkConfigs =
    cctpDomain != null ? cctpSDK.configs.networks.find((item) => item.domain === cctpDomain) : undefined;

  return cctpNetworkConfigs;
}

function bufToNativeString(options: { domain: CCTPDomain; buf: Buffer }) {
  const { domain, buf } = options;

  return domain === CCTPDomain.Solana ? new PublicKey(buf).toBase58() : byte32ToAddress({ bytes: buf });
}

function byte32ToAddress(options: { bytes: Uint8Array }): string {
  const { bytes } = options;

  return ethers.utils.hexlify(ethers.utils.stripZeros(bytes));
}

export function parseCCTPMessageData(message: string) {
  const decodedMessage = decodeMessage({ messageHex: message });
  const { sourceDomain, destinationDomain, nonce, burnToken, amount, messageSender, mintRecipient } = decodedMessage;

  return {
    originChain: getChainIdByDomain(sourceDomain),
    originAddress: burnToken,
    targetChain: getChainIdByDomain(destinationDomain),
    targetAddress: mintRecipient,
    amount: BigNumber.from(amount),
    sourceDomain: sourceDomain,
    targetDomain: destinationDomain,
    nonce: BigNumber.from(nonce),
    fromAddress: messageSender,
  };
}

export function getCCTPMessageReceivedData(options: {
  chainId: ChainId;
  messageReceivedLog: ethers.utils.LogDescription;
  mintAndWithdrawLog: ethers.utils.LogDescription;
}) {
  const { chainId, messageReceivedLog, mintAndWithdrawLog } = options;

  const { caller, sourceDomain, nonce, sender, messageBody } = messageReceivedLog.args;
  const { mintRecipient, amount, mintToken } = mintAndWithdrawLog.args;
  const _sender = bufToNativeString({ domain: sourceDomain, buf: Buffer.from(ethers.utils.arrayify(sender)) });

  return {
    caller,
    sender: _sender,
    sourceDomain,
    targetDomain: carrierChainIdCCTPDomainMap[chainId],
    nonce: nonce.toNumber(),
    mintRecipient,
    mintToken,
    amount: (amount as BigNumber).toBigInt(),
    messageBody,
  };
}

// for backward compatibility, we need to keep index the wormhole cctp transaction
export const CCTPConfigs: {
  [chainId: number]: { wormholeContractAddress: string; usdcAddress: string };
} =
  CLUSTER === "mainnet"
    ? {
        [CHAIN_ID_ETH]: {
          wormholeContractAddress: "0xAaDA05BD399372f0b0463744C09113c137636f6a",
          usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
        [CHAIN_ID_AVAX]: {
          wormholeContractAddress: "0x09fb06a271faff70a651047395aaeb6265265f13",
          usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        },
        [CHAIN_ID_ARBITRUM]: {
          wormholeContractAddress: "0x2703483b1a5a7c577e8680de9df8be03c6f30e3c",
          usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        },
        [CHAIN_ID_OPTIMISM]: {
          wormholeContractAddress: "0x2703483b1a5a7c577e8680de9df8be03c6f30e3c",
          usdcAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
        },
        [CHAIN_ID_BASE]: {
          wormholeContractAddress: "0x03faBB06Fa052557143dC28eFCFc63FC12843f1D",
          usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      }
    : {
        [CHAIN_ID_ETH]: {
          wormholeContractAddress: "0x0A69146716B3a21622287Efa1607424c663069a4",
          usdcAddress: "0x07865c6E87B9F70255377e024ace6630C1Eaa37F",
        },
        [CHAIN_ID_AVAX]: {
          wormholeContractAddress: "0x58f4c17449c90665891c42e14d34aae7a26a472e",
          usdcAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
        },
        [CHAIN_ID_ARBITRUM]: {
          wormholeContractAddress: "0x2e8f5e00a9c5d450a72700546b89e2b70dfb00f2",
          usdcAddress: "0xfd064A18f3BF249cf1f87FC203E90D8f650f2d63",
        },
        [CHAIN_ID_OPTIMISM]: {
          wormholeContractAddress: "0x2703483B1a5a7c577e8680de9Df8Be03c6f30e3c",
          usdcAddress: "0xe05606174bac4a6364b31bd0eca4bf4dd368f8c6",
        },
        [CHAIN_ID_BASE]: {
          wormholeContractAddress: "0x2703483B1a5a7c577e8680de9Df8Be03c6f30e3c",
          usdcAddress: "0xf175520c52418dfe19c8098071a252da48cd1c19",
        },
      };

export async function parseUSDCVaaPayload(options: { chainId: ChainId; payload: Buffer }): Promise<TokenTransfer> {
  const { chainId, payload } = options;
  const payloadType = payload.readUInt8(0);

  if (payloadType !== TokenBridgePayload.Transfer) {
    throw new Error("not usdc bridge transfer VAA");
  }

  const tokenAddressBuffer = payload.subarray(1, 33);
  const amount = BigInt(ethers.BigNumber.from(payload.subarray(33, 65)).toString());
  const sourceDomain = payload.readUintBE(65, 4); // +4
  const targetDomain = payload.readUintBE(69, 4); // +4
  const nonce = payload.readUint8(73); // +8
  const fromAddressBuffer = payload.subarray(81, 113);
  const mintRecipientBuffer = payload.subarray(113, 145);
  const payloadLen = payload.readUintBE(145, 2); // +2
  const tokenTransferPayload = payload.subarray(147);
  const provider = getEVMProviderWithWormholeChain(chainId);
  const contract = new Contract(CCTPConfigs[chainId].wormholeContractAddress, WormholeCCTPIntegrationABI, provider);
  // const originChain = await contract.getChainIdFromDomain(sourceDomain);
  const originChain = chainId; // we use chainId to be originChain for now because getChainIdFromDomain(sourceDomain) return incorrect result.
  const targetChain = await contract.getChainIdFromDomain(targetDomain);

  return {
    payloadType,
    amount,
    tokenAddress: tokenAddressBuffer,
    tokenChain: originChain,
    to: mintRecipientBuffer,
    toChain: targetChain,
    fee: null,
    fromAddress: fromAddressBuffer,
    tokenTransferPayload,
  };
}

export function hashSourceChainAndNonce(sourceDomain: number, nonce: BigNumber) {
  const cctpHashedSourceAndNonce = solidityKeccak256(["uint32", "uint64"], [sourceDomain, nonce]);

  return cctpHashedSourceAndNonce;
}
