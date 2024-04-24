import {
  CHAIN_ID_SOLANA,
  ChainId,
  getIsTransferCompletedEth,
  getIsTransferCompletedSolana,
  isEVMChain,
} from "../utils/wormhole";
import { getChainIdsList, getChainInfoFromWormholeChain, getEVMProviderWithWormholeChain } from "../bridge";
import { TransactionModel } from "../database/txnModel";
import { TXN_STATUS, TXN_TYPE } from "../utils/constants";
import { constructSolanaConnection } from "../utils/solana";

const supportedChains = getChainIdsList();

function isFulfilled<T>(val: PromiseSettledResult<T>): val is PromiseFulfilledResult<T> {
  return val.status === "fulfilled";
}

export async function checkRedeemed(filter: any) {
  console.log("start check redeemed with", JSON.stringify(filter));
  const FLUSH_SIZE = 20;
  let promises: Promise<boolean>[] = [];
  let promisesContext: any[] = [];
  let txnIds: any[] = [];
  let query: any = { status: TXN_STATUS.CONFIRMED, txnType: { $in: [TXN_TYPE.TOKEN_BRIDGE, TXN_TYPE.NFT_BRIDGE] } };
  for (const key in filter) {
    query[key] = filter[key];
  }
  let cursor = TransactionModel.find(query).sort("-created").cursor();

  try {
    let tryFlush = async (max: number) => {
      if (promises.length >= max) {
        let redeemeds = await Promise.allSettled<boolean>(promises);
        for (const i in promises) {
          let redeemed = redeemeds[i];
          if (isFulfilled(redeemed)) {
            if (redeemed.value) {
              txnIds.push(promisesContext[i]._id);
              console.log("mark redeemed for", promisesContext[i].txn);
            }
          }
        }
        promises = [];
        promisesContext = [];
      }
      if (txnIds.length >= max) {
        let filter = { _id: { $in: txnIds } };
        let update = { $set: { status: TXN_STATUS.REDEEMED, updated: new Date() } };
        // console.log("filter:", filter, ", update", update);
        await TransactionModel.updateMany(filter, update);
        txnIds = [];
      }
    };
    while (true) {
      let txn = await cursor.next();
      if (!txn) {
        break;
      }

      if (!supportedChains.includes(txn.destChainId as ChainId)) {
        // skip those dest chain which we don't support
        continue;
      }

      const chainDetails = getChainInfoFromWormholeChain(txn.destChainId);
      let contractAddress = "";
      if (txn.txnType == TXN_TYPE.TOKEN_BRIDGE && chainDetails.wormholeTokenBridge) {
        contractAddress = chainDetails.wormholeTokenBridge;
      } else if (txn.txnType == TXN_TYPE.NFT_BRIDGE && chainDetails.wormholeNFTBridge) {
        contractAddress = chainDetails.wormholeNFTBridge;
      } else {
        console.error("unknown txn: ", txn._id);
        continue;
      }
      if (!txn.signedVAABytes) {
        console.error("unknown txn missing signedVAABytes: ", txn._id);
        continue;
      }
      const vaa = Buffer.from(txn.signedVAABytes, "base64");

      try {
        if (isEVMChain(chainDetails.chainId)) {
          const provider = getEVMProviderWithWormholeChain(chainDetails.chainId);

          if (!provider) {
            continue;
          }

          promises.push(getIsTransferCompletedEth(contractAddress, provider, vaa));
          promisesContext.push(txn);
        } else if (chainDetails.chainId === CHAIN_ID_SOLANA) {
          const connection = constructSolanaConnection("confirmed");

          promises.push(getIsTransferCompletedSolana(contractAddress, vaa, connection, "confirmed"));
          promisesContext.push(txn);
        }
      } catch (e) {
        console.error(e);
        // in case of rpc error
        // can continue with other transactions
        continue;
      }
      await tryFlush(FLUSH_SIZE);
    }
    await tryFlush(1);
  } catch (e) {
    console.error(e);
  }
  cursor.close();
}
