import { Fragment, Interface } from "ethers/lib/utils";
import { JsonFragment } from "@ethersproject/abi";
import { getEVMProviderWithWormholeChain } from "../bridge";
import { ChainId } from "../utils/wormhole";
import { BlockNumber, TransactionType } from "../database/blockNumberModel";

export async function getEthTransaction(options: { chainId: ChainId; txHash: string }) {
  const { chainId, txHash } = options;
  const provider = getEVMProviderWithWormholeChain(chainId);

  const txn = await provider?.getTransaction(txHash);

  return txn;
}

export async function getEthTransactionReceipt(options: { chainId: ChainId; txHash: string }) {
  const { chainId, txHash } = options;
  const provider = getEVMProviderWithWormholeChain(chainId);

  const receipt = await provider?.getTransactionReceipt(txHash);

  return receipt;
}

export function decodeTx(abis: (string | ReadonlyArray<Fragment | JsonFragment | string>)[], data: string) {
  for (let i = 0; i < abis.length; i++) {
    try {
      const iface = new Interface(abis[i]);

      return iface.parseTransaction({ data });
    } catch (e) {}
  }
}

export function parseLog(iface: Interface, logs: Array<any>, methodName: string) {
  for (const receiptLog of logs) {
    try {
      let parsedLog = iface.parseLog(receiptLog);

      if (parsedLog.name === methodName) {
        return { log: receiptLog, parsedLog };
      }
    } catch (e) {
      // the correct log might be the other logs in the list
      continue;
    }
  }
}

const latestIndexedBlockNumbers: { [chainId: number]: { [type: number]: number } } = {};

// every 5 mins, timer will save latestIndexedBlockNumber to db
// when the server reboot, getLatestIndexedBlockNumber will get latestIndexedBlockNumber from db
setInterval(async () => {
  const chainIds = Object.keys(latestIndexedBlockNumbers).map((chainIdStr) => parseInt(chainIdStr) as ChainId);

  for (const chainId of chainIds) {
    const indexedBlockNumberCacheByChain = latestIndexedBlockNumbers[chainId];
    const transferBlockNumber = indexedBlockNumberCacheByChain
      ? indexedBlockNumberCacheByChain[TransactionType.Transfer]
      : undefined;
    const redemptionBlockNumber = indexedBlockNumberCacheByChain
      ? indexedBlockNumberCacheByChain[TransactionType.Redemption]
      : undefined;

    if (transferBlockNumber) {
      await saveLatestIndexedBlockNumberToDB(TransactionType.Transfer, chainId, transferBlockNumber);
    }

    if (redemptionBlockNumber) {
      await saveLatestIndexedBlockNumberToDB(TransactionType.Redemption, chainId, redemptionBlockNumber);
    }
  }
}, 5 * 60 * 1000);

export function saveLatestIndexedBlockNumber(type: TransactionType, chainId: ChainId, blockNumber: number) {
  const blockNumberCacheByChain = latestIndexedBlockNumbers[chainId];
  const blockNumberCache = blockNumberCacheByChain ? blockNumberCacheByChain[type] : undefined;

  if (blockNumberCache == null || blockNumber > blockNumberCache) {
    latestIndexedBlockNumbers[chainId] = latestIndexedBlockNumbers[chainId] || {};
    latestIndexedBlockNumbers[chainId][type] = blockNumber;
  }
}

export async function saveLatestIndexedBlockNumberToDB(type: TransactionType, chainId: ChainId, blockNumber: number) {
  let blockNo = await BlockNumber.findOne({ type, chainId });
  const now = new Date();

  if (!blockNo) {
    blockNo = new BlockNumber({
      type,
      chainId,
      created: now,
      updated: now,
    });
  }

  if (blockNo.latestIndexedBlockNumber == null || blockNumber > blockNo.latestIndexedBlockNumber) {
    blockNo.latestIndexedBlockNumber = blockNumber;
    blockNo.updated = now;

    console.log(`[ChainId: ${chainId}, BlockNO: ${blockNumber}] block number save to db`);

    await blockNo.save();
  }
}

export async function getLatestIndexedBlockNumber(type: TransactionType, chainId: ChainId): Promise<number> {
  const blockNumberCacheByChain = latestIndexedBlockNumbers[chainId];
  const blockNumberCache = blockNumberCacheByChain ? blockNumberCacheByChain[type] : undefined;

  if (!blockNumberCache) {
    const blockNo = await BlockNumber.findOne({ type, chainId });

    if (blockNo) {
      saveLatestIndexedBlockNumber(type, chainId, blockNo.latestIndexedBlockNumber);

      return blockNo.latestIndexedBlockNumber;
    } else {
      const provider = getEVMProviderWithWormholeChain(chainId);

      if (!provider) {
        throw new Error(`can't find provider, chainId ${chainId}`);
      }

      const latestBlockNumber = await provider.getBlockNumber();

      saveLatestIndexedBlockNumber(type, chainId, latestBlockNumber);
      await saveLatestIndexedBlockNumberToDB(type, chainId, latestBlockNumber);

      return latestBlockNumber;
    }
  } else {
    return blockNumberCache;
  }
}
