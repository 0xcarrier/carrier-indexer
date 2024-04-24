import {
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_OASIS,
  CHAIN_ID_SOLANA,
  ChainId,
  NftTransfer,
  TokenTransfer,
  getSignedVAAHash,
  isEVMChain,
  parseNftTransferPayload,
  parseTokenTransferPayload,
  parseVaa,
  tryHexToNativeString,
  tryUint8ArrayToNative,
} from "../utils/wormhole";
import {
  CHAIN_INFO,
  MOONBEAM_MRL_PRECOMPILE_ADDRESS,
  MetricsProvider,
  getBridgeChains,
  getEVMProviderWithWormholeChain,
  getTBTCAddressForChain,
  getTBTCGatewayForChain,
  getWtBTCAddressForChain,
  isEVMChainEnabled,
} from "../bridge";
import { work } from "../utils/worker";
import { Provider, BlockWithTransactions } from "@ethersproject/abstract-provider";
import { decodeTx, getLatestIndexedBlockNumber, parseLog, saveLatestIndexedBlockNumber } from "../utils/ethereum";
import { ethers } from "ethers";
import wormholeMRLTransferABI from "../utils/abi/WormholeMRLTransferABI.json";
import wormholeCoreBridgeABI from "../utils/abi/WormholeCoreBridge.json";
import WormholeTokenBridgeABI from "../utils/abi/WormholeTokenBridge.json";
import WormholeNFTBridgeABI from "../utils/abi/WormholeNFTBridge.json";
import WormholeCCTPIntegrationABI from "../utils/abi/WormholeCCTPIntegration.json";
import WormholeTbtcABI from "../utils/abi/WormholeTbtc.json";
import ERC20ABI from "../utils/abi/ERC20.json";
import ERC721ABI from "../utils/abi/ERC721.json";
import BatchABI from "../utils/abi/Batch.json";
import CCTPTokenMessengerABI from "../utils/abi/TokenMessenger.json";
import CCTPMessageTransmitterABI from "../utils/abi/MessageTransmitter.json";
import {
  convertPayloadToUint8Array,
  fetchForeignAsset,
  getERC20Info,
  getERC721Info,
  isChainSupported,
  isNFTTransferPayload,
  isTokenTransferPayload,
  normalizeHexAddress,
  tryRecipientAddressToNative,
} from "../utils/utils";
import { Interface } from "ethers/lib/utils";
import { TXN_STATUS, TXN_TYPE } from "../utils/constants";
import { ITxn, TransactionModel } from "../database/txnModel";
import { MrlRedemptionTransactionModel } from "../database/mrlRedemptionTxnModel";
import { PolkachainTokens, parsePolkachainTxPayload } from "../utils/polkadot";
import { IToken } from "../database/tokenModel";
import { addTokensToDB, addTransactionToDB, addTransactionsToDB } from "../database/helper";
import { Document } from "mongoose";
import { MrlTransferTransactionModel } from "../database/mrlTransferTxnModel";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { constructSolanaConnection, getSolanaTokenInfo } from "../utils/solana";
import { TransactionType } from "../database/blockNumberModel";
import {
  IManualIndexedTransactions,
  ManualIndexedTransactionStatus,
  ManualIndexedTransactions,
} from "../database/manualIndexedTransactionModel";
import {
  CCTPConfigs,
  carrierChainIdCCTPDomainMap,
  cctpSDK,
  getCCTPMessageReceivedData,
  getChainIdByDomain,
  hashSourceChainAndNonce,
  parseCCTPMessageData,
  parseUSDCVaaPayload,
} from "../utils/cctp";
import { CCTPDomain } from "@automata-network/cctp-sdk";

enum EVMTokenBridgeMethods {
  CompleteTransfer = "completeTransfer",
  CompleteTransferWithPayload = "completeTransferWithPayload",
  CompleteTransferAndUnwrapETH = "completeTransferAndUnwrapETH",
  CompleteTransferAndUnwrapETHWithPayload = "completeTransferAndUnwrapETHWithPayload",
  WrapAndTransferETH = "wrapAndTransferETH",
  WrapAndTransferETHWithPayload = "wrapAndTransferETHWithPayload",
  TransferTokens = "transferTokens",
  TransferTokensWithPayload = "transferTokensWithPayload",
}

enum EVMNFTBridgeMethods {
  CompleteTransfer = "completeTransfer",
  TransferNFT = "transferNFT",
}

enum EVMUSDCBridgeMethods {
  TransferTokensWithPayload = "transferTokensWithPayload",
  RedeemTokensWithPayload = "redeemTokensWithPayload",
}

enum EVMTBTCBridgeMethods {
  SendTbtc = "sendTbtc",
  ReceiveTbtc = "receiveTbtc",
}

enum MRLBridgeMethods {
  WormholeTransferERC20 = "wormholeTransferERC20",
}

interface BaseQueueItem {
  id: string;
  retries?: number;
  provider?: MetricsProvider;
}

let latestEVMPollerResponseTime: { [chainId: number]: number } = {};
let startUpBlocks: { [chainId: number]: number } = {};
let previousIndexedRedemptionBlocks: { [chainId: number]: number } = {};

export function getLatestEVMPollerResponseTime(chainId: ChainId) {
  return latestEVMPollerResponseTime[chainId];
}

export function setLatestEVMPollerResponseTime(chainId: ChainId, value: number) {
  latestEVMPollerResponseTime[chainId] = value;
}

interface ManualIndexedTransactionQueueItem extends BaseQueueItem {
  transaction: IManualIndexedTransactions;
}

export function indexManualIndexedTransactions() {
  const bridgeChainsList = getBridgeChains();
  const maxRecordsPerRound = 100;

  for (const [chainName, chainDetails] of Object.entries(bridgeChainsList)) {
    if (!chainDetails.rpcUrls.length || !isEVMChain(chainDetails.chainId) || !isEVMChainEnabled(chainDetails.chainId)) {
      continue;
    }

    const manualQueue: ManualIndexedTransactionQueueItem[] = [];
    const workers = work({
      concurrentWorker: 2,
      queue: manualQueue,
      timeout: 60 * 1000,
      handler: async (task) => {
        const provider = getEVMProviderWithWormholeChain(chainDetails.chainId, 0);

        if (!provider) {
          throw new Error(`No alive provider`);
        } else {
          task.provider = provider;
        }

        // console.time(`Manual index on ${chainName},${task.transaction.hash}`);
        console.log(
          `Start index transaction manually on ${chainName}, hash: ${task.transaction.hash}, rpc: ${provider.connection.url}`,
        );

        await indexManualSubmittedTransaction(chainDetails, provider, task.transaction);

        console.log(
          `End index transaction manually on ${chainName}, hash: ${task.transaction.hash}, queue length: ${manualQueue.length}`,
        );
        // console.timeEnd(`Manual index on ${chainName},${task.transaction.hash}`);
      },
      onTimeout: (task) => {
        retryTask({ task, queue: manualQueue, maxRetry: 3 });

        console.log(
          `Manual index worker timeout on ${chainName}, hash: ${task.transaction.hash}, provider: ${
            task.provider?.connection.url || "null"
          }`,
        );
        // console.timeEnd(`Manual index on ${chainName},${task.transaction.hash}`);
      },
      onError: (task, err) => {
        retryTask({ task, queue: manualQueue, maxRetry: 3 });

        console.error(
          `Manual index worker error happens on ${chainName}, hash: ${task.transaction.hash}, provider: ${
            task.provider?.connection.url || "null"
          }.`,
          err,
        );
        // console.timeEnd(`Manual index on ${chainName},${task.transaction.hash}`);
      },
    });

    setInterval(async () => {
      try {
        const count = await ManualIndexedTransactions.count({
          chainId: chainDetails.chainId,
          status: ManualIndexedTransactionStatus.Pending,
        });
        const transactions = await ManualIndexedTransactions.find({
          chainId: chainDetails.chainId,
          status: ManualIndexedTransactionStatus.Pending,
        }).limit(count > maxRecordsPerRound ? maxRecordsPerRound : count);
        const nonExistedTransactions = transactions.filter(
          (item) => manualQueue.findIndex((queueItem) => item.hash === queueItem.transaction.hash) === -1,
        );

        if (nonExistedTransactions.length) {
          manualQueue.push(...nonExistedTransactions.map((item) => ({ id: item.hash, transaction: item })));
        }

        console.log(
          `[ChainId: ${chainDetails.chainId}] Manual indexed queue update on ${chainName}. txns: ${
            nonExistedTransactions.length ? nonExistedTransactions.map((item) => item.hash).join(",") : "null"
          }`,
        );
      } catch (err) {
        console.error(`Manual index scheduler failed on ${chainName}`, err);
      }

      workers.awake();
    }, 60 * 1000);
  }
}

async function indexManualSubmittedTransaction(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  transaction: IManualIndexedTransactions,
) {
  try {
    await ManualIndexedTransactions.updateOne(
      { chainId: transaction.chainId, type: transaction.type, hash: transaction.hash },
      { status: ManualIndexedTransactionStatus.Processing, updated: new Date() },
    );

    let success = false;

    if (transaction.type === TransactionType.Transfer) {
      const receipt = await provider.getTransactionReceipt(transaction.hash);

      if (receipt && receipt.logs.length) {
        const iface = new Interface(wormholeCoreBridgeABI);
        const logMessageEventLog = parseLog(iface, receipt.logs, "LogMessagePublished");

        if (logMessageEventLog) {
          const tx = await provider.getTransaction(transaction.hash);
          const results = await indexEVMTransferDetails(chainDetails, provider, logMessageEventLog.parsedLog, tx);

          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${receipt.blockNumber}] transfer transaction details: `,
            JSON.stringify(results),
          );

          if (results) {
            await addTokensToDB(
              (results.tokenToSave ? [results.tokenToSave] : []).concat(
                results.destTokenToSave ? [results.destTokenToSave] : [],
              ),
            );

            if (results.txnToSave) {
              await addTransactionToDB(results.txnToSave);

              success = true;
            }
          }
        } else {
          const cctpIface = new Interface(CCTPMessageTransmitterABI);
          const messageSentLog = parseLog(cctpIface, receipt.logs, "MessageSent");

          if (messageSentLog) {
            const tx = await provider.getTransaction(transaction.hash);
            const results = await indexEVMCCTPTransferDetails(chainDetails, provider, messageSentLog.parsedLog, tx);

            console.log(
              `[ChainId: ${chainDetails.chainId}, BlockNO: ${receipt.blockNumber}] manual index cctp transfer transaction details: `,
              JSON.stringify(results),
            );

            if (results) {
              await addTokensToDB(
                (results.tokenToSave ? [results.tokenToSave] : []).concat(
                  results.destTokenToSave ? [results.destTokenToSave] : [],
                ),
              );

              if (results.txnToSave) {
                await addTransactionToDB(results.txnToSave);
                await linkCCTPTransferToRedeemTransaction(results.txnToSave.cctpHashedSourceAndNonce!);

                success = true;
              }
            }
          }
        }
      }
    } else if (transaction.type === TransactionType.Redemption) {
      const tx = await provider.getTransaction(transaction.hash);

      if (tx && tx.blockNumber) {
        const receipt = await provider.getTransactionReceipt(transaction.hash);

        const iface = new Interface(CCTPMessageTransmitterABI);
        const messageReceivedLog = parseLog(iface, receipt.logs, "MessageReceived");

        if (messageReceivedLog) {
          const results = await indexEVMCCTPRedemptionDetails(
            chainDetails,
            provider,
            tx.blockNumber,
            messageReceivedLog.parsedLog,
            tx,
          );

          if (results) {
            if (results.tokenInfo) {
              await addTokensToDB([results.tokenInfo]);
            }

            if (results.redeemTx) {
              await addTransactionToDB(results.redeemTx);
              await linkCCTPTransferToRedeemTransaction(results.redeemTx.cctpHashedSourceAndNonce!);

              success = true;
            }
          }
        } else {
          const results = await indexEVMRedemptionDetails(
            chainDetails,
            provider,
            tx.blockNumber,
            tx,
            RedemptionType.All,
          );

          if (results) {
            if (results.tokenInfo) {
              await addTokensToDB([results.tokenInfo]);
            }

            if (results.redeemTx) {
              await addTransactionToDB(results.redeemTx);

              if (results.vaaHash) {
                await linkTransferToRedeemTransaction(results.redeemTx, results.vaaHash);
              }

              success = true;
            }
          }
        }
      }
    }

    await ManualIndexedTransactions.updateOne(
      { chainId: transaction.chainId, type: transaction.type, hash: transaction.hash },
      {
        status: success ? ManualIndexedTransactionStatus.Success : ManualIndexedTransactionStatus.Failed,
        updated: new Date(),
      },
    );
  } catch (e) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, TxHash: ${transaction.hash}] error happens on index manual submitted transaction: `,
      e,
    );

    await ManualIndexedTransactions.updateOne(
      { chainId: transaction.chainId, type: transaction.type, hash: transaction.hash },
      { status: ManualIndexedTransactionStatus.Failed, updated: new Date() },
    );
  }
}

export enum TransactionQueueType {
  Transfer,
  CCTPTransfer,
  TokenRedemption,
  CCTPRedemption,
  NFTRedemption,
}

interface TransactionQueueItem extends BaseQueueItem {
  type: TransactionQueueType;
  log: ethers.providers.Log;
}

export function indexEVMTransactionsByLog() {
  const bridgeChainsList = getBridgeChains();

  for (const [chainName, chainDetails] of Object.entries(bridgeChainsList)) {
    if (!chainDetails.rpcUrls.length || !isEVMChain(chainDetails.chainId) || !isEVMChainEnabled(chainDetails.chainId)) {
      continue;
    }

    console.log(`[ChainId: ${chainDetails.chainId}] start index evm logs`);

    const cctpSourceNetworkConfigs = cctpSDK.configs.networks.find(
      (item) => item.domain === carrierChainIdCCTPDomainMap[chainDetails.chainId],
    );
    // consider we can handle 1 block in 100ms, every 30s we 300 blocks at most.
    // oasis rpc https://emerald.oasis.dev is not allow user fetch more than 100 blocks per round.
    // arbitrum produces blocks fast, so we need to search more blocks per round
    const maxBlockPerRound =
      chainDetails.chainId === CHAIN_ID_OASIS ? 100 : chainDetails.chainId === CHAIN_ID_ARBITRUM ? 4000 : 400;
    const queue: TransactionQueueItem[] = [];
    const workers = work({
      concurrentWorker: 3,
      queue,
      timeout: 60 * 1000,
      handler: async (task) => {
        const provider = getEVMProviderWithWormholeChain(chainDetails.chainId, 0);

        if (!provider) {
          throw new Error(`No alive provider`);
        } else {
          task.provider = provider;
        }

        // console.time(`Index log on ${chainName},${task.log.transactionHash}`);
        console.log(
          `Start index log on ${chainName}, hash: ${task.log.transactionHash}, rpc: ${provider.connection.url}`,
        );

        if (task.type === TransactionQueueType.Transfer) {
          await indexEVMTransferTransaction(chainDetails, provider, task.log.blockNumber, task.log);
        } else if (task.type === TransactionQueueType.CCTPTransfer) {
          await indexEVMCCTPTransferTransaction(chainDetails, provider, task.log.blockNumber, task.log);
        } else if (task.type === TransactionQueueType.TokenRedemption) {
          await indexEVMRedemptionTransactionByLog(chainDetails, provider, task.log.blockNumber, task.log);
        } else if (task.type === TransactionQueueType.CCTPRedemption) {
          await indexEVMCCTPRedemptionTransaction(chainDetails, provider, task.log.blockNumber, task.log);
        }

        console.log(`End index log on ${chainName}, hash: ${task.log.transactionHash}, queue length: ${queue.length}`);
        // console.timeEnd(`Index log on ${chainName},${task.log.transactionHash}`);
      },
      onTimeout: (task) => {
        retryTask({ task, queue, maxRetry: 2 });

        console.error(
          `Log worker timeout on ${chainName}, hash: ${task.log.transactionHash}, provider: ${
            task.provider?.connection.url || "null"
          }`,
        );
        // console.timeEnd(`Index log on ${chainName},${task.log.transactionHash}`);
      },
      onError: (task, err) => {
        retryTask({ task, queue, maxRetry: 2 });

        console.error(
          `Log worker error happens on ${chainName}, hash: ${task.log.transactionHash}, provider: ${
            task.provider?.connection.url || "null"
          }.`,
          err,
        );
        // console.timeEnd(`Index log on ${chainName},${task.log.transactionHash}`);
      },
    });

    setInterval(async () => {
      let provider: MetricsProvider | undefined;

      try {
        provider = getEVMProviderWithWormholeChain(chainDetails.chainId, 0);

        if (!provider) {
          throw new Error(`No alive provider`);
        }

        const latestBlockNumber = await provider.getBlockNumber();
        const latestIndexedBlock = await getLatestIndexedBlockNumber(TransactionType.Transfer, chainDetails.chainId);

        console.log(
          `[ChainId: ${chainDetails.chainId}] Latest block number: ${latestBlockNumber}, Latest indexed block number: ${latestIndexedBlock}`,
        );

        if (latestIndexedBlock < latestBlockNumber) {
          const fromBlock = latestIndexedBlock + 1;
          const toBlock =
            latestIndexedBlock + maxBlockPerRound < latestBlockNumber
              ? latestIndexedBlock + maxBlockPerRound
              : latestBlockNumber;

          const transferLogs = await provider.getLogs({
            address: chainDetails.wormholeCoreBridge,
            topics: [ethers.utils.id("LogMessagePublished(address,uint64,uint32,bytes,uint8)")],
            fromBlock,
            toBlock,
          });
          const tokenRedemptionLogs = await provider.getLogs({
            address: chainDetails.wormholeTokenBridge,
            topics: [ethers.utils.id("TransferRedeemed(uint16,bytes32,uint64)")],
            fromBlock,
            toBlock,
          });
          const cctpTransferLogs = cctpSourceNetworkConfigs
            ? await provider.getLogs({
                address: cctpSourceNetworkConfigs.cctpMessageTransmitterContractAddress,
                topics: [ethers.utils.id("MessageSent(bytes)")],
                fromBlock,
                toBlock,
              })
            : [];
          const cctpRedemptionLogs = cctpSourceNetworkConfigs
            ? await provider.getLogs({
                address: cctpSourceNetworkConfigs.cctpMessageTransmitterContractAddress,
                topics: [ethers.utils.id("MessageReceived(address,uint32,uint64,bytes32,bytes)")],
                fromBlock,
                toBlock,
              })
            : [];

          if (transferLogs.length) {
            transferLogs.forEach((log) => {
              if (!queue.find((item) => item.id === log.transactionHash)) {
                queue.push({
                  id: log.transactionHash,
                  type: TransactionQueueType.Transfer,
                  log: log,
                });
              }
            });
          }

          if (tokenRedemptionLogs.length) {
            tokenRedemptionLogs.forEach((log) => {
              if (!queue.find((item) => item.id === log.transactionHash)) {
                queue.push({
                  id: log.transactionHash,
                  type: TransactionQueueType.TokenRedemption,
                  log: log,
                });
              }
            });
          }

          const cctpTransferWithoutWormholeWrappingLogs = cctpTransferLogs.filter(
            (item) => !transferLogs.find((transferLog) => transferLog.transactionHash === item.transactionHash),
          );

          if (cctpTransferWithoutWormholeWrappingLogs.length) {
            cctpTransferWithoutWormholeWrappingLogs.forEach((log) => {
              if (!queue.find((item) => item.id === log.transactionHash)) {
                queue.push({
                  id: log.transactionHash,
                  type: TransactionQueueType.CCTPTransfer,
                  log: log,
                });
              }
            });
          }

          const cctpRedemptionWithoutWormholeWrappedLogs = cctpRedemptionLogs.filter(
            (item) => !tokenRedemptionLogs.find((transferLog) => transferLog.transactionHash === item.transactionHash),
          );

          if (cctpRedemptionWithoutWormholeWrappedLogs.length) {
            cctpRedemptionWithoutWormholeWrappedLogs.forEach((log) => {
              if (!queue.find((item) => item.id === log.transactionHash)) {
                queue.push({
                  id: log.transactionHash,
                  type: TransactionQueueType.CCTPRedemption,
                  log: log,
                });
              }
            });
          }

          saveLatestIndexedBlockNumber(TransactionType.Transfer, chainDetails.chainId, toBlock);

          console.log(
            `[ChainId: ${
              chainDetails.chainId
            }, BlockNO: ${fromBlock}-${toBlock}] Log queue update on ${chainName}. queue length: ${
              queue.length
            }, latest block: ${latestBlockNumber}, rpc: ${provider.connection.url}, transfer hashes: ${
              transferLogs.length ? transferLogs.map((item) => item.transactionHash).join(",") : "null"
            }, token redemption hashes: ${
              tokenRedemptionLogs.length ? tokenRedemptionLogs.map((item) => item.transactionHash).join(",") : "null"
            }`,
          );
        }

        setLatestEVMPollerResponseTime(chainDetails.chainId, Date.now());
      } catch (err) {
        console.error(`Log scheduler failed on ${chainName}, provider: ${provider?.connection.url || "null"}.`, err);
      }

      workers.awake();
    }, 60 * 1000);
  }
}

interface BlockWithTransactionQueueItem extends BaseQueueItem {
  block: number;
}

export function indexPastBlockEVMTransactions() {
  const bridgeChainsList = getBridgeChains();

  for (const [chainName, chainDetails] of Object.entries(bridgeChainsList)) {
    if (!chainDetails.rpcUrls.length || !isEVMChain(chainDetails.chainId) || !isEVMChainEnabled(chainDetails.chainId)) {
      continue;
    }

    // consider we can handle 1 block in 100ms, every 30s we 300 blocks at most.
    // oasis rpc https://emerald.oasis.dev is not allow user fetch more than 100 blocks per round.
    // arbitrum produces blocks fast, so we need to search more blocks per round
    const maxBlockPerRound =
      chainDetails.chainId === CHAIN_ID_OASIS ? 100 : chainDetails.chainId === CHAIN_ID_ARBITRUM ? 500 : 200;
    const queue: BlockWithTransactionQueueItem[] = [];
    const workers = work({
      concurrentWorker: 3,
      queue,
      timeout: 30 * 1000,
      handler: async (task) => {
        const provider = getEVMProviderWithWormholeChain(
          chainDetails.chainId,
          // if rpc more than 3, then use the last 2 rpcs to index the redemption by blocks.
          // otherwise, only use the last 1 rpc to do it
          chainDetails.rpcUrls.length <= 3 ? chainDetails.rpcUrls.length - 1 : chainDetails.rpcUrls.length - 2,
        );

        if (!provider) {
          throw new Error(`No alive provider`);
        } else {
          task.provider = provider;
        }

        // console.time(`Index past block on ${chainName},${task.block}`);
        console.log(`Start fetch block on ${chainName}, block: ${task.block}, rpc: ${provider.connection.url}`);

        const blockWithTransactions: BlockWithTransactions = await provider.getBlockWithTransactions(task.block);

        // we don't want to wait the index result
        // because index multiple transactions in one block maybe take some time
        // we can continue to the next block
        // we only index NFT here, if in the future
        // NFT redemption has some events can be recognized by the log filter
        // then we can remove the block indexer
        indexEVMRedemptionTransactionsByBlock(
          chainDetails,
          provider,
          task.block,
          blockWithTransactions,
          RedemptionType.NFT,
        ).catch((e) => {
          console.log(
            `Error happens on fetching block on ${chainName}, block: ${task.block}, queue length: ${queue.length}`,
          );
        });

        console.log(`End fetch block on ${chainName}, block: ${task.block}, queue length: ${queue.length}`);
        // console.timeEnd(`Index past block on ${chainName},${task.block}`);
      },
      onTimeout: (task) => {
        retryTask({ task, queue, maxRetry: 0 });

        console.log(
          `Past block worker timeout on ${chainName}, block: ${task.block}, provider: ${
            task.provider?.connection.url || "null"
          }`,
        );
        // console.timeEnd(`Index past block on ${chainName},${task.block}`);
      },
      onError: (task, err) => {
        retryTask({ task, queue, maxRetry: 0 });

        console.error(
          `Past block worker error happens on ${chainName}, block: ${task.block}, provider: ${
            task.provider?.connection.url || "null"
          }.`,
          err,
        );
        // console.timeEnd(`Index past block on ${chainName},${task.block}`);
      },
    });

    setInterval(async () => {
      let provider: MetricsProvider | undefined;

      try {
        provider = getEVMProviderWithWormholeChain(
          chainDetails.chainId,
          // if rpc more than 3, then use the last 2 rpcs to index the redemption by blocks.
          // otherwise, only use the last 1 rpc to do it
          chainDetails.rpcUrls.length <= 3 ? chainDetails.rpcUrls.length - 1 : chainDetails.rpcUrls.length - 2,
        );

        if (!provider) {
          throw new Error(`No alive provider`);
        }

        const startUpBlock = await getStartUpBlock(chainDetails.chainId);
        const latestIndexedBlock = await getLatestIndexedBlockNumber(TransactionType.Redemption, chainDetails.chainId);

        if (latestIndexedBlock < startUpBlock) {
          const fromBlock = latestIndexedBlock + 1;
          const toBlock =
            latestIndexedBlock + maxBlockPerRound < startUpBlock ? latestIndexedBlock + maxBlockPerRound : startUpBlock;

          for (let i = fromBlock; i <= toBlock; i++) {
            queue.push({ id: `${i}`, block: i });
          }

          saveLatestIndexedBlockNumber(TransactionType.Redemption, chainDetails.chainId, toBlock);

          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${fromBlock}-${toBlock}] Past block queue update on ${chainName}. queue length: ${queue.length}, startUp block: ${startUpBlock}, rpc: ${provider.connection.url}`,
          );
        }

        setLatestEVMPollerResponseTime(chainDetails.chainId, Date.now());
      } catch (err) {
        console.error(
          `Past block scheduler failed on ${chainName}, provider: ${provider?.connection.url || "null"}.`,
          err,
        );
      }

      workers.awake();
    }, 30 * 1000);
  }
}

export function indexEVMTransactionsByBlock() {
  const bridgeChainsList = getBridgeChains();

  for (const [chainName, chainDetails] of Object.entries(bridgeChainsList)) {
    if (!chainDetails.rpcUrls.length || !isEVMChain(chainDetails.chainId) || !isEVMChainEnabled(chainDetails.chainId)) {
      continue;
    }

    // consider we can handle 1 block in 100ms, every 30s we 300 blocks at most.
    // oasis rpc https://emerald.oasis.dev is not allow user fetch more than 100 blocks per round.
    // arbitrum produces blocks fast, so we need to search more blocks per round
    const maxBlockPerRound =
      chainDetails.chainId === CHAIN_ID_OASIS ? 100 : chainDetails.chainId === CHAIN_ID_ARBITRUM ? 500 : 200;
    const queue: BlockWithTransactionQueueItem[] = [];
    const workers = work({
      concurrentWorker: chainDetails.chainId === CHAIN_ID_ARBITRUM ? 7 : 5, // ARBITRUM produces blocks fast so we need more workers
      queue,
      timeout: 30 * 1000,
      handler: async (task) => {
        const provider = getEVMProviderWithWormholeChain(
          chainDetails.chainId,
          // if rpc more than 3, then use the last 2 rpcs to index the redemption by blocks.
          // otherwise, only use the last 1 rpc to do it
          chainDetails.rpcUrls.length <= 3 ? chainDetails.rpcUrls.length - 1 : chainDetails.rpcUrls.length - 2,
        );

        if (!provider) {
          throw new Error(`No alive provider`);
        } else {
          task.provider = provider;
        }

        // console.time(`Index block on ${chainName},${task.block}`);
        console.log(`Start fetch block on ${chainName}, block: ${task.block}, rpc: ${provider.connection.url}`);

        const blockWithTransactions: BlockWithTransactions | null = await provider.getBlockWithTransactions(task.block);

        if (blockWithTransactions == null) {
          throw new Error("blockWithTransactions is null");
        }

        // we don't want to wait the index result
        // because index multiple transactions in one block maybe take some time
        // we can continue to the next block
        // we only index NFT here, if in the future
        // NFT redemption has some events can be recognized by the log filter
        // then we can remove the block indexer
        indexEVMRedemptionTransactionsByBlock(
          chainDetails,
          provider,
          task.block,
          blockWithTransactions,
          RedemptionType.NFT,
        ).catch((e) => {
          console.log(
            `Error happens on fetching block on ${chainName}, block: ${task.block}, queue length: ${queue.length}`,
          );
        });

        console.log(`End fetch block on ${chainName}, block: ${task.block}, queue length: ${queue.length}`);
        // console.timeEnd(`Index block on ${chainName},${task.block}`);
      },
      onTimeout: (task) => {
        retryTask({ task, queue, maxRetry: 0 });

        console.log(
          `Block worker timeout on ${chainName}, block: ${task.block}, provider: ${
            task.provider?.connection.url || "null"
          }`,
        );
        // console.timeEnd(`Index block on ${chainName},${task.block}`);
      },
      onError: (task, err) => {
        retryTask({ task, queue, maxRetry: 0 });

        console.error(
          `Block worker error happens on ${chainName}, block: ${task.block}, provider: ${
            task.provider?.connection.url || "null"
          }.`,
          err,
        );
        // console.timeEnd(`Index block on ${chainName},${task.block}`);
      },
    });

    setInterval(async () => {
      let provider: MetricsProvider | undefined;

      try {
        provider = getEVMProviderWithWormholeChain(
          chainDetails.chainId,
          // if rpc more than 3, then use the last 2 rpcs to index the redemption by blocks.
          // otherwise, only use the last 1 rpc to do it
          chainDetails.rpcUrls.length <= 3 ? chainDetails.rpcUrls.length - 1 : chainDetails.rpcUrls.length - 2,
        );

        if (!provider) {
          throw new Error(`No alive provider`);
        }

        const latestBlockNumber = await provider.getBlockNumber();
        const previousBlock = getPreviousRedemptionBlock(chainDetails.chainId, latestBlockNumber);
        const latestIndexedPastBlock = await getLatestIndexedBlockNumber(
          TransactionType.Redemption,
          chainDetails.chainId,
        );
        const startUpBlock = await getStartUpBlock(chainDetails.chainId);

        if (previousBlock < latestBlockNumber) {
          const fromBlock = previousBlock + 1;
          const toBlock =
            previousBlock + maxBlockPerRound < latestBlockNumber ? previousBlock + maxBlockPerRound : latestBlockNumber;

          for (let i = fromBlock; i <= toBlock; i++) {
            queue.push({ id: `${i}`, block: i });
          }

          setPreviousRedemptionBlock(chainDetails.chainId, toBlock);

          if (latestIndexedPastBlock >= startUpBlock) {
            // need to sync the indexed block to the latest block
            saveLatestIndexedBlockNumber(TransactionType.Redemption, chainDetails.chainId, toBlock);
          }

          console.log(
            `[ChainId: ${
              chainDetails.chainId
            }, BlockNO: ${fromBlock}-${toBlock}] Block queue update on ${chainName}. queue length: ${
              queue.length
            }, latest block: ${latestBlockNumber}, rpc: ${provider.connection.url || "null"}`,
          );
        }

        setLatestEVMPollerResponseTime(chainDetails.chainId, Date.now());
      } catch (err) {
        console.error(`Block scheduler failed on ${chainName}, provider: ${provider?.connection.url || "null"}.`, err);
      }

      workers.awake();
    }, 30 * 1000);
  }
}

async function getStartUpBlock(chainId: ChainId) {
  const startUpBlock = startUpBlocks[chainId];

  if (!startUpBlock) {
    const provider = getEVMProviderWithWormholeChain(chainId);

    if (!provider) {
      throw new Error(`No alive provider`);
    }

    const latestBlockNumber = await provider.getBlockNumber();

    startUpBlocks[chainId] = latestBlockNumber;

    return latestBlockNumber;
  }

  return startUpBlock;
}

function getPreviousRedemptionBlock(chainId: ChainId, currentBlock: number) {
  const previousBlock = previousIndexedRedemptionBlocks[chainId];

  if (!previousBlock) {
    previousIndexedRedemptionBlocks[chainId] = currentBlock;

    return currentBlock;
  }

  return previousBlock;
}

function setPreviousRedemptionBlock(chainId: ChainId, block: number) {
  const previousBlock = previousIndexedRedemptionBlocks[chainId];

  if (previousBlock < block) {
    previousIndexedRedemptionBlocks[chainId] = block;
  }
}

async function indexEVMTransferTransaction(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  log: ethers.providers.Log,
) {
  try {
    // let signedVaaList = [];
    const iface = new Interface(wormholeCoreBridgeABI);

    const parsedLog = iface.parseLog(log);
    const transaction = await provider.getTransaction(log.transactionHash);
    const results = await indexEVMTransferDetails(chainDetails, provider, parsedLog, transaction);

    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] transfer transaction details: `,
      JSON.stringify(results),
    );

    if (results) {
      await addTokensToDB(
        (results.tokenToSave ? [results.tokenToSave] : []).concat(
          results.destTokenToSave ? [results.destTokenToSave] : [],
        ),
      );

      if (results.txnToSave) {
        await addTransactionToDB(results.txnToSave);
      }

      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] process tranfer done: ${results.txnToSave?.txn}`,
      );
    }
  } catch (err) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] error fetching transfer tx: ${log.transactionHash}`,
      err,
    );

    throw err;
  }
}

function retryTask(options: { task: BaseQueueItem; queue: BaseQueueItem[]; maxRetry: number }) {
  const { task, queue, maxRetry } = options;

  // timeout will also cause error, so we need to check the id
  if (!queue.find((item) => item.id === task.id)) {
    setTimeout(() => {
      task.retries = task.retries || 0;

      if (task.retries < maxRetry) {
        task.retries += 1;
        // push the task back to the end of the queue
        queue.push(task);
      }
    }, 10 * 60 * 1000);
  }
}

type EVMIndexedTransferResult = {
  tokenToSave: IToken | null;
  destTokenToSave: IToken | null;
  txnToSave: ITxn | null;
};

async function indexEVMTransferDetails(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  logMessageEventLog: ethers.utils.LogDescription,
  transactionInfo: ethers.providers.TransactionResponse,
): Promise<EVMIndexedTransferResult | undefined> {
  let destToken: IToken | null = null;
  let newToken: IToken | null = null;
  let newTxn: ITxn | null = null;

  if (!transactionInfo) {
    return;
  }

  const origSender = transactionInfo.from.toLowerCase() || ethers.constants.AddressZero;

  const {
    token: origToken,
    recipient: origRecipient,
    isSourceNative,
  } = parseParams(chainDetails.chainId, transactionInfo.data);

  const { sender: emitterAddress, sequence, nonce, payload, consistencyLevel } = logMessageEventLog.args;

  console.log(
    `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] transfer log args: `,
    JSON.stringify({
      txHash: transactionInfo.hash,
      sender: origSender,
      originAsset: origToken,
      recipient: origRecipient,
      isSourceNative: isSourceNative,
      emitterAddress,
      sequence: sequence.toString(),
      nonce,
    }),
  );

  const payloadBufferUint8Arr = convertPayloadToUint8Array(payload);
  const payloadBuffer = Buffer.from(payloadBufferUint8Arr);

  try {
    const isTokenBridge = emitterAddress.toLowerCase() === chainDetails.wormholeTokenBridge?.toLowerCase();
    const isNFTBridge = emitterAddress.toLowerCase() === chainDetails.wormholeNFTBridge?.toLowerCase();
    const isUSDCBridge =
      emitterAddress.toLowerCase() === CCTPConfigs[chainDetails.chainId]?.wormholeContractAddress.toLowerCase();

    if (isNFTBridge) {
      if (!isNFTTransferPayload(payloadBuffer)) {
        return;
      }

      const nftTransferPayload: NftTransfer = parseNftTransferPayload(payloadBuffer);

      const erc721Info = await getERC721Info(provider, origToken, chainDetails.chainId);
      if (erc721Info) {
        newToken = erc721Info;
      }

      try {
        console.log(
          `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] transfer payload and nft token: `,
          JSON.stringify({
            txHash: transactionInfo.hash,
            nftTransferPayload: {
              ...nftTransferPayload,
              tokenAddress: tryUint8ArrayToNative(
                new Uint8Array(nftTransferPayload.tokenAddress),
                nftTransferPayload.tokenChain as ChainId,
              ),
              to: tryUint8ArrayToNative(new Uint8Array(nftTransferPayload.to), nftTransferPayload.toChain as ChainId),
            },
            erc721Info,
          }),
        );
      } catch (e) {}

      newTxn = {
        txnType: TXN_TYPE.NFT_BRIDGE,
        txn: transactionInfo.hash,
        sender: origSender,
        recipient: tryRecipientAddressToNative(origRecipient, nftTransferPayload.toChain as ChainId),
        tokenId: nftTransferPayload.tokenId.toString(),
        isSourceNative: isSourceNative,
        unwrappedSourceTokenAddress: tryRecipientAddressToNative(
          nftTransferPayload.tokenAddress.toString("hex"),
          nftTransferPayload.tokenChain as ChainId,
        ),
        unwrappedSourceChainId: nftTransferPayload.tokenChain,
        sourceTokenAddress: origToken,
        sourceChainId: chainDetails.chainId,
        destChainId: nftTransferPayload.toChain,
        emitterAddress: emitterAddress.toLowerCase(),
        wormholeSequence: ethers.BigNumber.from(sequence).toString(),
        status: TXN_STATUS.PENDING,
      } as ITxn;
    } else if (isTokenBridge || isUSDCBridge) {
      if (!isTokenTransferPayload(payloadBuffer)) {
        return;
      }

      const tokenTransferPayload = isTokenBridge
        ? parseTokenTransferPayload(payloadBuffer)
        : await parseUSDCVaaPayload({
            chainId: chainDetails.chainId,
            payload: payloadBuffer,
          });

      const toChain = tokenTransferPayload.toChain;

      if (!isChainSupported(toChain as ChainId)) {
        return;
      }

      const toAddress = tryUint8ArrayToNative(
        new Uint8Array(tokenTransferPayload.to),
        tokenTransferPayload.toChain as ChainId,
      );

      const tokenAddress = tryUint8ArrayToNative(
        new Uint8Array(tokenTransferPayload.tokenAddress),
        tokenTransferPayload.tokenChain as ChainId,
      );

      const mrlTransferTx = await MrlTransferTransactionModel.findOne({
        ethTxn: transactionInfo.hash,
      });

      if (mrlTransferTx) {
        console.log(
          `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] MRLTransferTx found.`,
          mrlTransferTx.txn,
        );
      }

      const isMRLTransferFromEvm: boolean =
        toChain === CHAIN_ID_MOONBEAM && toAddress.toLowerCase() === MOONBEAM_MRL_PRECOMPILE_ADDRESS.toLowerCase();
      const isMRLTransferFromPolkachain = mrlTransferTx != null;
      const mrlPayload = isMRLTransferFromEvm
        ? await parsePolkachainTxPayload(tokenTransferPayload.tokenTransferPayload)
        : undefined;
      const amount = ethers.BigNumber.from(tokenTransferPayload.amount.toString());
      const fee = tokenTransferPayload.fee ? tokenTransferPayload.fee.toString() : "0";

      const unwrappedSourceTokenAddress = tryRecipientAddressToNative(
        tokenTransferPayload.tokenAddress.toString("hex"),
        tokenTransferPayload.tokenChain as ChainId,
      );

      const foreginChain = tokenTransferPayload.toChain;
      const unwrappedSourceChainId = tokenTransferPayload.tokenChain as ChainId;

      const erc20Info = await getERC20Info(provider, origToken, chainDetails.chainId);
      if (erc20Info) {
        newToken = erc20Info;
      }

      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] transfer payload and erc20 token: `,
        JSON.stringify(
          {
            txHash: transactionInfo.hash,
            tokenTransferPayload: {
              ...tokenTransferPayload,
              toChain,
              tokenAddress,
              toAddress,
            },
            erc20Info,
          },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      );

      // compute dest token address
      let txn = transactionInfo.hash;
      let sender = origSender;
      let sourceChainId = chainDetails.chainId;
      let sourceTokenAddress = origToken;
      let isNative = isSourceNative;
      let destTokenAddress = ethers.constants.AddressZero;
      let originAddressInput = ethers.constants.AddressZero;
      let originChainInput = 0;
      let recipient = ethers.constants.AddressZero;
      let destChainId = tokenTransferPayload.toChain;

      if (isMRLTransferFromPolkachain) {
        txn = mrlTransferTx.txn;
        sender = mrlTransferTx.sender;
        sourceChainId = mrlTransferTx.sourceChainId;

        const tokenData = PolkachainTokens[sourceChainId].find(
          (item) => item.tokenAddressOnMoonbeam.toLowerCase() === sourceTokenAddress.toLowerCase(),
        );

        if (tokenData) {
          sourceTokenAddress = tokenData.assetId;
          isNative = tokenData.isNative;

          newToken = {
            chainId: mrlTransferTx.sourceChainId,
            tokenAddress: tokenData.assetId,
            name: tokenData.name,
            symbol: tokenData.symbol,
            decimals: tokenData.decimals,
          } as IToken;
        }
      }

      if (isMRLTransferFromEvm) {
        if (mrlPayload) {
          recipient = mrlPayload.accountId;
          destChainId = mrlPayload.parachainId;
        }
      } else {
        recipient = tryRecipientAddressToNative(origRecipient, tokenTransferPayload.toChain as ChainId);

        if (recipient.toLowerCase() === getTBTCGatewayForChain(tokenTransferPayload.toChain as ChainId).toLowerCase()) {
          if (tokenTransferPayload.toChain === CHAIN_ID_SOLANA) {
            const recipientOwner = tryUint8ArrayToNative(
              new Uint8Array(tokenTransferPayload.tokenTransferPayload),
              tokenTransferPayload.toChain as ChainId,
            );
            recipient = (
              await getAssociatedTokenAddress(
                new PublicKey(getTBTCAddressForChain(CHAIN_ID_SOLANA)),
                new PublicKey(recipientOwner),
              )
            ).toString();
          } else {
            recipient = tryUint8ArrayToNative(
              new Uint8Array(tokenTransferPayload.tokenTransferPayload),
              tokenTransferPayload.toChain as ChainId,
            );
          }
        }
      }
      // always use unwrapped token address if possible
      if (unwrappedSourceTokenAddress && unwrappedSourceTokenAddress !== ethers.constants.AddressZero) {
        originAddressInput = unwrappedSourceTokenAddress;
        originChainInput = unwrappedSourceChainId;
      } else {
        originAddressInput = origToken;
        originChainInput = chainDetails.chainId;
      }

      if (originChainInput === foreginChain) {
        // no foreign asset; unwrapped source token address is already the foreign asset
        destTokenAddress = originAddressInput;
      } else {
        // TODO check if it is solana chain id?
        const foreignAsset = await fetchForeignAsset(
          originAddressInput,
          originChainInput as ChainId,
          foreginChain as ChainId,
        );
        if (foreignAsset && foreignAsset !== ethers.constants.AddressZero) {
          destTokenAddress = foreignAsset;

          if (isMRLTransferFromEvm) {
            const tokenData = PolkachainTokens[destChainId].find(
              (item) => item.tokenAddressOnMoonbeam?.toLowerCase() === destTokenAddress.toLowerCase(),
            );

            if (tokenData) {
              destTokenAddress = tokenData.assetId;

              destToken = {
                chainId: destChainId,
                tokenAddress: tokenData.assetId,
                name: tokenData.name,
                symbol: tokenData.symbol,
                decimals: tokenData.decimals,
              } as IToken;
            }
          } else if (isEVMChain(foreginChain as ChainId)) {
            destTokenAddress = destTokenAddress.toLowerCase();

            const destProvider = getEVMProviderWithWormholeChain(foreginChain as ChainId);
            if (destProvider) {
              const destERC20Info = await getERC20Info(destProvider, destTokenAddress, foreginChain as ChainId);
              if (destERC20Info) {
                destToken = destERC20Info;
              }
            }
          } else if ((foreginChain as ChainId) === CHAIN_ID_SOLANA) {
            const solanaConnection = constructSolanaConnection("confirmed");
            const destSolTokenInfo = await getSolanaTokenInfo(solanaConnection, destTokenAddress);
            if (destSolTokenInfo) {
              destToken = destSolTokenInfo;
            }
          }

          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] desitination token: `,
            JSON.stringify({
              txHash: txn,
              destToken,
            }),
          );
        }
      }

      newTxn = {
        txnType: TXN_TYPE.TOKEN_BRIDGE,
        txn,
        sender,
        recipient,
        tokenAmt: amount.toString(),
        arbiterFee: fee,
        isSourceNative: isNative,
        destTokenAddress,
        unwrappedSourceTokenAddress: unwrappedSourceTokenAddress,
        unwrappedSourceChainId: unwrappedSourceChainId,
        sourceTokenAddress,
        sourceChainId,
        destChainId,
        emitterAddress: emitterAddress.toLowerCase(),
        wormholeSequence: ethers.BigNumber.from(sequence).toString(),
        status: TXN_STATUS.PENDING,
      } as ITxn;
    }
  } catch (error) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] process transfer transaction error: `,
      error,
    );

    throw error;
  }

  return {
    destTokenToSave: destToken,
    tokenToSave: newToken,
    txnToSave: newTxn,
  } as EVMIndexedTransferResult;
}

async function indexEVMCCTPTransferTransaction(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  log: ethers.providers.Log,
) {
  try {
    // let signedVaaList = [];
    const iface = new Interface(CCTPMessageTransmitterABI);

    const parsedLog = iface.parseLog(log);
    const transaction = await provider.getTransaction(log.transactionHash);
    const results = await indexEVMCCTPTransferDetails(chainDetails, provider, parsedLog, transaction);

    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] cctp transfer transaction details: `,
      JSON.stringify(results),
    );

    if (results) {
      const tokens = (results.tokenToSave ? [results.tokenToSave] : []).concat(
        results.destTokenToSave ? [results.destTokenToSave] : [],
      );

      if (tokens.length) {
        await addTokensToDB(tokens);
      }

      if (results.txnToSave) {
        await addTransactionToDB(results.txnToSave);
        await linkCCTPTransferToRedeemTransaction(results.txnToSave.cctpHashedSourceAndNonce!);
      }

      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] process cctp tranfer done: ${results.txnToSave?.txn}`,
      );
    }
  } catch (err) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] error fetching cctp transfer tx: ${log.transactionHash}`,
      err,
    );

    throw err;
  }
}

async function indexEVMCCTPTransferDetails(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  messageSentLog: ethers.utils.LogDescription,
  transactionInfo: ethers.providers.TransactionResponse,
): Promise<EVMIndexedTransferResult | undefined> {
  let destToken: IToken | null = null;
  let newToken: IToken | null = null;
  let newTxn: ITxn | null = null;

  if (!transactionInfo) {
    return;
  }

  const {
    originChain,
    originAddress,
    targetChain,
    targetAddress,
    sourceDomain,
    targetDomain,
    fromAddress,
    amount,
    nonce,
  } = parseCCTPMessageData(messageSentLog.args.message);

  console.log(
    `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] cctp transfer log args: `,
    JSON.stringify({
      txHash: transactionInfo.hash,
      originChain,
      originAddress,
      targetChain,
      targetAddress,
      sourceDomain,
      targetDomain,
      fromAddress,
      amount: amount.toString(),
      nonce,
    }),
  );

  try {
    if (!isChainSupported(targetChain) || !isChainSupported(originChain)) {
      return;
    }

    const erc20Info = await getERC20Info(provider, originAddress, chainDetails.chainId);

    if (erc20Info) {
      newToken = erc20Info;
    }

    const destTokenAddress =
      (await fetchForeignAsset(originAddress, originChain, targetChain)) || ethers.constants.AddressZero;

    if (targetDomain === CCTPDomain.Solana) {
      const connection = constructSolanaConnection("confirmed");
      const solTokenInfo = await getSolanaTokenInfo(connection, destTokenAddress);

      if (solTokenInfo) {
        destToken = solTokenInfo;
      }
    } else {
      const destProvider = getEVMProviderWithWormholeChain(targetChain);
      const destERC20Info = destProvider ? await getERC20Info(destProvider, destTokenAddress, targetChain) : undefined;

      if (destERC20Info) {
        destToken = destERC20Info;
      }
    }

    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] cctp transfer payload and erc20 token: `,
      JSON.stringify(
        {
          txHash: transactionInfo.hash,
          tokenTransferPayload: {
            originChain,
            originAddress,
            targetChain,
            targetAddress,
            sourceDomain,
            targetDomain,
            fromAddress,
            amount,
            nonce,
          },
          erc20Info,
          destToken,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );

    // compute dest token address

    newTxn = {
      txnType: TXN_TYPE.TOKEN_BRIDGE,
      txn: transactionInfo.hash,
      sender: fromAddress,
      recipient: targetAddress,
      tokenAmt: amount.toString(),
      arbiterFee: "0",
      isSourceNative: false,
      unwrappedSourceTokenAddress: originAddress,
      unwrappedSourceChainId: chainDetails.chainId,
      sourceTokenAddress: originAddress,
      sourceChainId: chainDetails.chainId,
      destChainId: targetChain,
      destTokenAddress: destTokenAddress,
      cctpHashedSourceAndNonce: hashSourceChainAndNonce(sourceDomain, nonce),
      status: TXN_STATUS.CONFIRMED,
    } as ITxn;
  } catch (error) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${transactionInfo.blockNumber}] process cctp transfer transaction error: `,
      error,
    );

    throw error;
  }

  return {
    destTokenToSave: destToken,
    tokenToSave: newToken,
    txnToSave: newTxn,
  } as EVMIndexedTransferResult;
}

async function indexEVMCCTPRedemptionTransaction(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  log: ethers.providers.Log,
) {
  try {
    const iface = new Interface(CCTPMessageTransmitterABI);
    const parsedLog = iface.parseLog(log);
    const transaction = await provider.getTransaction(log.transactionHash);
    const results = await indexEVMCCTPRedemptionDetails(chainDetails, provider, block, parsedLog, transaction);

    if (results) {
      if (results.redeemTx) {
        await addTransactionToDB(results.redeemTx);
        await linkCCTPTransferToRedeemTransaction(results.redeemTx.cctpHashedSourceAndNonce!);
      }
      if (results.tokenInfo) {
        await addTokensToDB([results.tokenInfo]);
      }

      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] process cctp redemption done: ${results.redeemTx?.txn}`,
      );
    }
  } catch (e) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] error happens on indexEVMCCTPRedemptionTransaction: `,
      e,
    );

    throw e;
  }
}
async function indexEVMCCTPRedemptionDetails(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  messageReceivedLog: ethers.utils.LogDescription,
  transactionInfo: ethers.providers.TransactionResponse,
) {
  let tokenInfo: IToken | undefined = undefined;
  let redeemTx: ITxn | undefined = undefined;

  if (!transactionInfo || !transactionInfo.to) {
    return;
  }

  const receipt = await provider.getTransactionReceipt(transactionInfo.hash);
  // console.log("receipt: ", receipt);
  // console.log("transaction hash info: ", transactionInfo);

  if (!receipt || !receipt.logs) {
    return;
  }
  const iface = new Interface(CCTPTokenMessengerABI);

  const mintAndWithdrawLog = parseLog(iface, receipt.logs, "MintAndWithdraw");

  if (!mintAndWithdrawLog) {
    return;
  }

  const { caller, sender, sourceDomain, targetDomain, nonce, mintRecipient, mintToken, amount, messageBody } =
    getCCTPMessageReceivedData({
      chainId: chainDetails.chainId,
      messageReceivedLog,
      mintAndWithdrawLog: mintAndWithdrawLog.parsedLog,
    });

  console.log(
    `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] cctp redemption log args: `,
    JSON.stringify({
      txHash: transactionInfo.hash,
      caller,
      sender,
      sourceDomain,
      targetDomain,
      nonce,
      mintRecipient,
      mintToken,
      amount: amount.toString(),
      messageBody,
    }),
  );

  const cctpSourceNetworkConfigs = cctpSDK.configs.networks.find((item) => item.domain === sourceDomain);

  const sourceChain = getChainIdByDomain(sourceDomain);
  const targetChain = getChainIdByDomain(targetDomain);

  try {
    if (!isChainSupported(sourceChain) || !isChainSupported(targetChain) || !cctpSourceNetworkConfigs) {
      return;
    }

    const erc20Info = await getERC20Info(provider, mintToken, chainDetails.chainId);

    if (erc20Info) {
      tokenInfo = erc20Info;
    }

    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] cctp redemption payload and erc20 token: `,
      JSON.stringify(
        {
          txHash: transactionInfo.hash,
          tokenInfo,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );

    // compute dest token address

    redeemTx = {
      txnType: TXN_TYPE.REDEEM,
      txn: transactionInfo.hash,
      sender: transactionInfo.from,
      recipient: mintRecipient,
      isSourceNative: false,
      unwrappedSourceTokenAddress: cctpSourceNetworkConfigs.usdcContractAddress,
      unwrappedSourceChainId: sourceChain,
      destTokenAddress: mintToken.toString(),
      destChainId: chainDetails.chainId,
      tokenAmt: amount.toString(),
      cctpHashedSourceAndNonce: hashSourceChainAndNonce(sourceDomain, nonce),
      status: TXN_STATUS.CONFIRMED,
    } as ITxn;
  } catch (error) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] process cctp redemption transaction error: `,
      error,
    );

    throw error;
  }

  return {
    redeemTx,
    tokenInfo,
  };
}

type DecodeParam = {
  token: string;
  recipient: string;
  isSourceNative: boolean;
};

function parseParams(chainId: ChainId, data: string): DecodeParam {
  let result = {
    token: ethers.constants.AddressZero,
    recipient: ethers.constants.AddressZero,
    isSourceNative: false,
  };

  const decodeData = decodeTx(
    [WormholeTokenBridgeABI, WormholeNFTBridgeABI, WormholeCCTPIntegrationABI, WormholeTbtcABI, BatchABI],
    data,
  );

  // console.log("decode data: ", decodeData);

  // might not be able to decode
  // e.g. chain calls
  if (!decodeData) {
    return result;
  }

  try {
    if (decodeData.functionFragment.name === "sendTbtc") {
      result.token = getTBTCAddressForChain(chainId);
      result.recipient = normalizeHexAddress(decodeData.args[2]);
      result.isSourceNative = false;
    } else if (
      decodeData.functionFragment.name === "wrapAndTransferETH" ||
      decodeData.functionFragment.name === "wrapAndTransferETHWithPayload"
    ) {
      result.recipient = normalizeHexAddress(decodeData.args[1]);
      result.isSourceNative = true;
    } else if (
      decodeData.functionFragment.name === "transferTokens" ||
      decodeData.functionFragment.name === "transferTokensWithPayload"
    ) {
      // for usdc cctp: https://github.com/wormhole-foundation/wormhole-circle-integration/blob/main/evm/src/circle_integration/CircleIntegration.sol#LL50C40-L50C58
      if (decodeData.functionFragment.inputs[0].name === "transferParams") {
        result.token = decodeData.args[0][0];
        result.recipient = normalizeHexAddress(decodeData.args[0][3]);
        result.isSourceNative = false;
      } else {
        result.token = decodeData.args[0];
        result.recipient = normalizeHexAddress(decodeData.args[3]);
        result.isSourceNative = false;
      }
    } else if (decodeData.functionFragment.name === "transferNFT") {
      result.token = decodeData.args[0];
      result.recipient = normalizeHexAddress(decodeData.args[3]);
      result.isSourceNative = false;
    } else if (decodeData.functionFragment.name === "batchAll") {
      const transferTokenData = decodeData.args[2][1];
      const decodedTransferData = decodeTx([WormholeTokenBridgeABI], transferTokenData);
      if (
        decodedTransferData &&
        (decodedTransferData.functionFragment.name === "transferTokens" ||
          decodedTransferData.functionFragment.name === "transferTokensWithPayload")
      ) {
        result.token = decodedTransferData.args[0];
        result.recipient = normalizeHexAddress(decodedTransferData.args[3]);
        result.isSourceNative = false;
      }
    } else {
      console.log("not found decoded method: ", decodeData.functionFragment.name);
    }
  } catch (e) {
    console.error(e);

    throw e;
  }

  return result;
}

async function indexEVMRedemptionTransactionsByBlock(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  blockWithTransactions: BlockWithTransactions,
  indexRedemptionType: RedemptionType,
) {
  try {
    const redeemTxns: ITxn[] = [];
    const signedVaaHashList: string[] = [];
    const newTokensList: IToken[] = [];

    for (const transaction of blockWithTransactions.transactions) {
      const results = await indexEVMRedemptionDetails(chainDetails, provider, block, transaction, indexRedemptionType);

      if (results) {
        if (results.redeemTx) {
          redeemTxns.push(results.redeemTx);
        }

        if (results.tokenInfo) {
          newTokensList.push(results.tokenInfo);
        }

        if (results.vaaHash) {
          signedVaaHashList.push(results.vaaHash);
        }
      }
    }

    if (newTokensList.length > 0) {
      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] new redemption tokens: `,
        newTokensList.map((item) => item.tokenAddress).join(","),
      );
    }

    if (redeemTxns.length > 0) {
      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] new redemption transactions: `,
        redeemTxns.map((item) => item.txn).join(","),
      );
    }

    // save redeem txn to db
    // link transfer to redeem tx
    await addTokensToDB(newTokensList);
    await addTransactionsToDB(redeemTxns);
    await linkTransferToRedeemTransactionInBatch(redeemTxns, signedVaaHashList);
  } catch (e) {
    console.log(`[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] error fetching redeem tx: `, e);

    throw e;
  }
}

async function indexEVMRedemptionTransactionByLog(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  log: ethers.providers.Log,
) {
  try {
    const transaction = await provider.getTransaction(log.transactionHash);
    const results = await indexEVMRedemptionDetails(chainDetails, provider, block, transaction, RedemptionType.All);

    if (results) {
      if (results.redeemTx) {
        await addTransactionToDB(results.redeemTx);

        if (results.vaaHash) {
          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] link redemption start: ${results.redeemTx?.txn}`,
          );

          await linkTransferToRedeemTransaction(results.redeemTx, results.vaaHash);

          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] link redemption done: ${results.redeemTx?.txn}`,
          );
        }
      }

      if (results.tokenInfo) {
        console.log(`[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] add token start: ${results.redeemTx?.txn}`);

        await addTokensToDB([results.tokenInfo]);

        console.log(`[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] add token done: ${results.redeemTx?.txn}`);
      }

      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] process redemption done: ${results.redeemTx?.txn}`,
      );
    }
  } catch (e) {
    console.log(
      `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] error happens on indexEVMRedemptionTransactionByLog: `,
      e,
    );

    throw e;
  }
}

enum RedemptionType {
  All,
  Token,
  NFT,
}

async function indexEVMRedemptionDetails(
  chainDetails: CHAIN_INFO,
  provider: Provider,
  block: number,
  transaction: ethers.providers.TransactionResponse,
  indexRedemptionType: RedemptionType,
) {
  let tokenInfo: IToken | undefined = undefined;
  let redeemTx: ITxn | undefined = undefined;
  let vaaHash: string | undefined = undefined;

  if (!transaction || !transaction.to) {
    return;
  }

  const isMRLBridge =
    chainDetails.chainId === CHAIN_ID_MOONBEAM &&
    transaction.to.toLowerCase() === MOONBEAM_MRL_PRECOMPILE_ADDRESS.toLowerCase();

  const isTokenBridge = transaction.to.toLowerCase() === chainDetails.wormholeTokenBridge?.toLowerCase();
  const isNFTBridge = transaction.to.toLowerCase() === chainDetails.wormholeNFTBridge?.toLowerCase();
  const isUSDCBridge =
    transaction.to.toLowerCase() === CCTPConfigs[chainDetails.chainId]?.wormholeContractAddress.toLowerCase();
  const isTBtcBridge = transaction.to.toLowerCase() === getTBTCGatewayForChain(chainDetails.chainId).toLowerCase();
  const isWormhole = isMRLBridge || isTokenBridge || isNFTBridge || isUSDCBridge || isTBtcBridge;

  if (!isWormhole) {
    // skip transactions that are not going to wormhole
    return;
  }

  const receipt = await provider.getTransactionReceipt(transaction.hash);
  // console.log("receipt: ", receipt);
  // console.log("transaction hash info: ", transactionInfo);

  if (!receipt) {
    return;
  }

  const decodeData = decodeTx(
    [WormholeTokenBridgeABI, WormholeNFTBridgeABI, WormholeCCTPIntegrationABI, WormholeTbtcABI, wormholeMRLTransferABI],
    transaction.data,
  );

  if (!decodeData) {
    // transaction data not recognise
    return;
  } else if (
    decodeData.functionFragment.name !== EVMTokenBridgeMethods.CompleteTransfer &&
    decodeData.functionFragment.name !== EVMTokenBridgeMethods.CompleteTransferWithPayload &&
    decodeData.functionFragment.name !== EVMTokenBridgeMethods.CompleteTransferAndUnwrapETH &&
    decodeData.functionFragment.name !== EVMTokenBridgeMethods.CompleteTransferAndUnwrapETHWithPayload &&
    decodeData.functionFragment.name !== EVMNFTBridgeMethods.CompleteTransfer &&
    decodeData.functionFragment.name !== EVMUSDCBridgeMethods.RedeemTokensWithPayload &&
    decodeData.functionFragment.name !== EVMTBTCBridgeMethods.ReceiveTbtc &&
    decodeData.functionFragment.name !== MRLBridgeMethods.WormholeTransferERC20
  ) {
    // method name is not complete transfer
    return;
  }

  const vaaBuffer = convertPayloadToUint8Array(isUSDCBridge ? decodeData.args[0][0] : decodeData.args[0]);
  const vaaBytes = Buffer.from(vaaBuffer).toString("base64");
  const { emitterChain, emitterAddress, sequence, payload, hash } = parseVaa(vaaBuffer);

  if (!isChainSupported(emitterChain as ChainId)) {
    return;
  }

  const _emitterAddress = tryHexToNativeString(emitterAddress.toString("hex"), emitterChain as ChainId).toLowerCase();

  console.log(
    `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] redemption transaction info: `,
    JSON.stringify({
      bridgeMethods: decodeData.functionFragment.name,
      txHash: receipt.transactionHash,
      emitterAddress: _emitterAddress,
      sequence: sequence.toString(),
    }),
  );

  let transferPayload: TokenTransfer | NftTransfer | undefined = undefined;
  let destTokenAddress = ethers.constants.AddressZero;
  let recipient = ethers.constants.AddressZero;
  let unwrappedSourceTokenAddress = ethers.constants.AddressZero;

  if (
    (isMRLBridge || isTokenBridge || isUSDCBridge || isTBtcBridge) &&
    (indexRedemptionType === RedemptionType.All || indexRedemptionType === RedemptionType.Token)
  ) {
    transferPayload =
      isMRLBridge || isTokenBridge || isTBtcBridge
        ? parseTokenTransferPayload(payload)
        : await parseUSDCVaaPayload({ chainId: emitterChain as ChainId, payload });

    recipient = tryRecipientAddressToNative(
      isTBtcBridge ? transferPayload.tokenTransferPayload.toString("hex") : transferPayload.to.toString("hex"),
      transferPayload.toChain as ChainId,
    );

    let unwrappedSourceChainId = transferPayload.tokenChain;

    unwrappedSourceTokenAddress = tryRecipientAddressToNative(
      transferPayload.tokenAddress.toString("hex"),
      unwrappedSourceChainId as ChainId,
    );

    try {
      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] token redemption transaction payload: `,
        JSON.stringify({
          txHash: receipt.transactionHash,
          transferPayload: {
            ...transferPayload,
            tokenAddress: tryUint8ArrayToNative(
              new Uint8Array(transferPayload.tokenAddress),
              transferPayload.tokenChain as ChainId,
            ),
            to: tryUint8ArrayToNative(new Uint8Array(transferPayload.to), transferPayload.toChain as ChainId),
          },
        }),
      );
    } catch (e) {}

    if (
      (decodeData.functionFragment.name === EVMTokenBridgeMethods.CompleteTransfer ||
        decodeData.functionFragment.name === EVMTokenBridgeMethods.CompleteTransferWithPayload ||
        decodeData.functionFragment.name === EVMUSDCBridgeMethods.RedeemTokensWithPayload ||
        decodeData.functionFragment.name === EVMTBTCBridgeMethods.ReceiveTbtc ||
        decodeData.functionFragment.name === MRLBridgeMethods.WormholeTransferERC20) &&
      receipt.logs.length > 0
    ) {
      // erc20 transfer detected
      // record what token is being transferred for UI display
      const iface = new Interface(ERC20ABI);
      const transferLog = parseLog(iface, receipt.logs, "Transfer");

      if (transferLog) {
        destTokenAddress = transferLog.log.address.toLowerCase();

        if (
          isTBtcBridge &&
          getWtBTCAddressForChain(chainDetails.chainId).toLowerCase() === destTokenAddress.toLowerCase()
        ) {
          destTokenAddress = getTBTCAddressForChain(chainDetails.chainId);
        }

        tokenInfo = await getERC20Info(provider, destTokenAddress, chainDetails.chainId);

        console.log(
          `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] token redemption transaction token info: `,
          JSON.stringify({
            txHash: receipt.transactionHash,
            tokenInfo,
          }),
        );
      }
    }

    const sequenceString = ethers.BigNumber.from(sequence).toString();
    vaaHash = getSignedVAAHash(vaaBuffer);
    redeemTx = {
      txnType: TXN_TYPE.REDEEM,
      txn: receipt.transactionHash,
      sender: receipt.from.toLowerCase(),
      recipient,
      isSourceNative: false,
      unwrappedSourceTokenAddress,
      unwrappedSourceChainId,
      destTokenAddress,
      destChainId: chainDetails.chainId,
      tokenAmt: transferPayload.amount.toString(),
      emitterAddress: _emitterAddress.toLowerCase(),
      wormholeSequence: sequenceString,
      signedVAABytes: vaaBytes,
      signedVAAHash: vaaHash,
      status: TXN_STATUS.CONFIRMED,
    } as ITxn;

    if (isMRLBridge) {
      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] mrlTx findOne: `,
        JSON.stringify({ emitterChain, emitterAddress: _emitterAddress.toLowerCase(), sequence: sequenceString }),
      );

      const mrlTx = await MrlRedemptionTransactionModel.findOne({
        emitterChain,
        emitterAddress: _emitterAddress.toLowerCase(),
        sequence: sequenceString,
      });

      if (mrlTx) {
        console.log(`[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] mrlTx found: `, mrlTx.txn);

        const mrlPayload = await parsePolkachainTxPayload(Buffer.from(mrlTx.mrlPayloadBytes, "base64"));

        if (mrlPayload) {
          const tokenData = PolkachainTokens[mrlPayload.parachainId]?.find(
            (item) => item.tokenAddressOnMoonbeam.toLowerCase() === redeemTx?.destTokenAddress.toLowerCase(),
          );

          redeemTx.destChainId = mrlPayload.parachainId;
          redeemTx.recipient = mrlPayload.accountId;
          redeemTx.txn = mrlTx.txn;

          console.log(
            `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] mrl redeemTx created: `,
            JSON.stringify({
              destChainId: mrlPayload.parachainId,
              recipient: mrlPayload.accountId,
              txn: mrlTx.txn,
            }),
          );

          if (tokenData) {
            redeemTx.destTokenAddress = tokenData.assetId;

            tokenInfo = {
              chainId: mrlPayload.parachainId,
              tokenAddress: tokenData.assetId,
              name: tokenData.name,
              symbol: tokenData.symbol,
              decimals: tokenData.decimals,
            } as IToken;

            console.log(
              `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] mrl token created: `,
              JSON.stringify({
                chainId: mrlPayload.parachainId,
                tokenAddress: tokenData.assetId,
                name: tokenData.name,
                symbol: tokenData.symbol,
                decimals: tokenData.decimals,
              }),
            );
          }
        }
      }
    }
  } else if (
    isNFTBridge &&
    (indexRedemptionType === RedemptionType.All || indexRedemptionType === RedemptionType.NFT)
  ) {
    transferPayload = parseNftTransferPayload(payload);

    recipient = tryRecipientAddressToNative(transferPayload.to.toString("hex"), transferPayload.toChain as ChainId);

    try {
      console.log(
        `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] NFT redemption transaction payload: `,
        JSON.stringify({
          txHash: receipt.transactionHash,
          transferPayload: {
            ...transferPayload,
            tokenAddress: tryUint8ArrayToNative(
              new Uint8Array(transferPayload.tokenAddress),
              transferPayload.tokenChain as ChainId,
            ),
            to: tryUint8ArrayToNative(new Uint8Array(transferPayload.to), transferPayload.toChain as ChainId),
          },
        }),
      );
    } catch (e) {}

    let unwrappedSourceChainId = transferPayload.tokenChain;

    unwrappedSourceTokenAddress = tryRecipientAddressToNative(
      transferPayload.tokenAddress.toString("hex"),
      unwrappedSourceChainId as ChainId,
    );
    if (receipt.logs.length > 0) {
      let iface = new Interface(ERC721ABI);
      const transferLog = parseLog(iface, receipt.logs, "Transfer");

      if (transferLog) {
        destTokenAddress = transferLog.log.address.toLowerCase();
        tokenInfo = await getERC721Info(provider, destTokenAddress, chainDetails.chainId);

        console.log(
          `[ChainId: ${chainDetails.chainId}, BlockNO: ${block}] NFT redemption transaction token info: `,
          JSON.stringify({
            txHash: receipt.transactionHash,
            tokenInfo,
          }),
        );
      }
    }

    const sequenceString = ethers.BigNumber.from(sequence).toString();
    vaaHash = getSignedVAAHash(vaaBuffer);
    redeemTx = {
      txnType: TXN_TYPE.REDEEM,
      txn: receipt.transactionHash,
      sender: receipt.from.toLowerCase(),
      recipient: recipient,
      isSourceNative: false,
      unwrappedSourceTokenAddress,
      unwrappedSourceChainId,
      destTokenAddress,
      destChainId: chainDetails.chainId,
      tokenId: transferPayload.tokenId.toString(),
      emitterAddress: _emitterAddress.toLowerCase(),
      wormholeSequence: sequenceString,
      signedVAABytes: vaaBytes,
      signedVAAHash: vaaHash,
      status: TXN_STATUS.CONFIRMED,
    } as ITxn;
  }

  return {
    vaaHash,
    tokenInfo,
    redeemTx,
  };
}

async function linkTransferToRedeemTransaction(redeemTxn: ITxn, vaa: string) {
  if (
    redeemTxn.destChainId === CHAIN_ID_MOONBEAM &&
    redeemTxn.recipient.toLowerCase() === MOONBEAM_MRL_PRECOMPILE_ADDRESS
  ) {
    return;
  }

  console.log(`link redemption start: ${redeemTxn.txn}`);

  const transferTxn = await TransactionModel.findOne({
    $and: [
      {
        signedVAAHash: vaa,
      },
      {
        $or: [
          { txnType: TXN_TYPE.TOKEN_BRIDGE, signedVAAHash: vaa },
          { txnType: TXN_TYPE.NFT_BRIDGE, signedVAAHash: vaa },
        ],
      },
    ],
  });

  console.log(`link redemption find transfer, redeem: ${redeemTxn.txn}, transfer: ${transferTxn?.txn || "null"}`);

  if (transferTxn) {
    transferTxn.redeemTxn = redeemTxn.txn;
    transferTxn.status = TXN_STATUS.REDEEMED;
    transferTxn.updated = new Date();

    console.log(`link redemption transfer start to save, redeem: ${redeemTxn.txn}, transfer: ${transferTxn.txn}`);

    await transferTxn.save();

    console.log(`link redemption find transfer, redeem: ${redeemTxn.txn}, transfer: ${transferTxn.txn}`);
  }
}

async function linkTransferToRedeemTransactionInBatch(redeemTxns: ITxn[], vaaList: string[]) {
  if (!vaaList.length) {
    return;
  }

  // console.log("find signed vaa list: ", signedVaaList);

  const transferTxns = await TransactionModel.find({
    $and: [
      {
        signedVAAHash: {
          $in: vaaList,
        },
      },
      {
        $or: [{ txnType: TXN_TYPE.TOKEN_BRIDGE }, { txnType: TXN_TYPE.NFT_BRIDGE }],
      },
    ],
  });

  // console.log("found related transfer txns: ", transferTxns);

  let modifiedTransferTxns: Document[] = [];

  for (let i = 0; i < vaaList.length; i++) {
    const vaaHash = vaaList[i];
    const redeemTxn = redeemTxns[i];

    // we don't need to link redemption transaction to transfer transaction for the MRL redemption.
    // it will be done when the parachain xcm message received.
    if (
      redeemTxn.destChainId === CHAIN_ID_MOONBEAM &&
      redeemTxn.recipient.toLowerCase() === MOONBEAM_MRL_PRECOMPILE_ADDRESS
    ) {
      continue;
    }

    const transferTxn = transferTxns.find((item) => item.signedVAAHash === vaaHash);

    if (vaaHash && redeemTxn && transferTxn) {
      transferTxn.redeemTxn = redeemTxn.txn;
      transferTxn.status = TXN_STATUS.REDEEMED;
      transferTxn.updated = new Date();
      modifiedTransferTxns.push(transferTxn);
    }
  }

  if (modifiedTransferTxns.length > 0) {
    // console.log("modified txns: ", modifiedTransferTxns);
    await TransactionModel.bulkSave(modifiedTransferTxns);
  }
}

async function linkCCTPTransferToRedeemTransaction(cctpHashedSourceAndNonce: string) {
  const transferTxn = await TransactionModel.findOne({
    txnType: TXN_TYPE.TOKEN_BRIDGE,
    cctpHashedSourceAndNonce,
  });

  const redeemTxn = await TransactionModel.findOne({
    txnType: TXN_TYPE.REDEEM,
    cctpHashedSourceAndNonce,
  });

  if (transferTxn && redeemTxn && !transferTxn.redeemTxn) {
    transferTxn.redeemTxn = redeemTxn.txn;
    transferTxn.status = TXN_STATUS.REDEEMED;
    transferTxn.updated = new Date();

    await transferTxn.save();
  }
}

const pollingTimeout = 60 * 60 * 1000;

export function startEVMIndexer() {
  indexEVMTransactionsByLog();
  indexManualIndexedTransactions();

  setInterval(() => {
    const bridgeChainsList = getBridgeChains();

    for (const [chainName, chainDetails] of Object.entries(bridgeChainsList)) {
      if (isEVMChain(chainDetails.chainId) && isEVMChainEnabled(chainDetails.chainId)) {
        const respTime = getLatestEVMPollerResponseTime(chainDetails.chainId);

        if (respTime && respTime + pollingTimeout < Date.now()) {
          console.error(`EVM poller timeout, chainId: ${chainDetails.chainId}`);
        }
      }
    }
  }, 60 * 1000);
}
