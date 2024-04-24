import { ChainId, CHAIN_ID_SOLANA, getSignedVAAHash, uint8ArrayToHex, CHAIN_ID_MOONBEAM } from "../utils/wormhole";
import { arrayify, zeroPad } from "ethers/lib/utils";
import { MOONBEAM_MRL_PRECOMPILE_ADDRESS, Polkachain } from "../bridge";
import { ITxn, TransactionModel } from "../database/txnModel";
import { fetchVaaFromWormholeRpcHosts, isCarrierPolkaChain } from "../utils/utils";
import { TXN_STATUS, TXN_TYPE } from "../utils/constants";
import { Document } from "mongoose";
import { work } from "../utils/worker";

const maxRecordPerRound = 1000;

function formatEmitterAddress(emitterAddress: string, chainId: ChainId) {
  if (chainId === CHAIN_ID_SOLANA) {
    return emitterAddress;
  }
  // assume if not solana, means transaction belongs to evm one
  return uint8ArrayToHex(zeroPad(arrayify(emitterAddress), 32));
}

export function fetchVAAs() {
  const queue: { tx: Document<unknown, any, ITxn> & ITxn }[] = [];
  const workers = work({
    concurrentWorker: 10,
    queue,
    timeout: 60 * 1000,
    handler: async (task) => {
      console.time(`Index VAA on ${task.tx.txn}`);
      console.log(`Start to fetch VAA, hash: ${task.tx.txn}`);

      await fetchTxnVaa(task.tx);

      // reduce the request frequency
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 500);
      });

      console.log(`End fetching VAA, hash: ${task.tx.txn}, queue length: ${queue.length}`);
      console.timeEnd(`Index VAA on ${task.tx.txn}`);
    },
    onTimeout: (task) => {
      console.error(`VAA worker timeout, hash: ${task.tx.txn}`);
      console.timeEnd(`Index VAA on ${task.tx.txn}`);
    },
    onError: (task, err) => {
      console.error(`VAA worker timeout, hash: ${task.tx.txn}`, err);
      console.timeEnd(`Index VAA on ${task.tx.txn}`);
    },
  });

  setInterval(async () => {
    try {
      const pendingTxs = await TransactionModel.find({
        $and: [
          { status: TXN_STATUS.PENDING },
          { $or: [{ txnType: TXN_TYPE.TOKEN_BRIDGE }, { txnType: TXN_TYPE.NFT_BRIDGE }] },
        ],
      })
        .sort({ created: 1 })
        .limit(maxRecordPerRound);

      const newPendingTxs = pendingTxs
        .filter((tx) => !queue.find((item) => item.tx.txn !== tx.txn))
        .map((item) => ({ tx: item }));

      queue.push(...newPendingTxs);

      console.log(
        `VAA queue update. queue length: ${queue.length}, hashes: ${
          newPendingTxs.length ? newPendingTxs.map((item) => item.tx.txn).join(",") : "null"
        }`,
      );
    } catch (e) {
      console.error("VAA scheduler failed", e);
    }

    workers.awake();
  }, 60 * 1000);
}

async function fetchTxnVaa(txnObject: Document<unknown, any, ITxn> & ITxn) {
  if (!txnObject.emitterAddress || !txnObject.wormholeSequence) {
    return;
  }

  // wormhole needs the address to be padded
  const chainId = txnObject.sourceChainId as ChainId;
  const emitterAddress = formatEmitterAddress(txnObject.emitterAddress, chainId);
  const signedVaa = await fetchVaaFromWormholeRpcHosts({
    chainId: isCarrierPolkaChain(chainId as Polkachain) ? CHAIN_ID_MOONBEAM : chainId,
    emitterAddress,
    sequence: txnObject.wormholeSequence,
  });

  console.log(`VAA worker get signedVaa. transfer: ${txnObject.txn}, signedVaa: ${signedVaa?.vaaBytes}`);

  if (signedVaa != null && signedVaa.vaaBytes) {
    const vaaHash = getSignedVAAHash(Buffer.from(signedVaa.vaaBytes, "base64"));

    const redeemTx = await TransactionModel.findOne({
      $and: [
        { txnType: TXN_TYPE.REDEEM },
        { signedVAAHash: vaaHash },
        // transaction sent to MRL_PRECOMPILE_ADDRESS will handle by moonbeam mrl contract and bridge to polkadot networks
        // those redeem transactions will be link to their transfer transaction on polkadot subscriber
        // because we need to wait until the polkadot extrinsic executed and the redeem record is updated
        { destChainId: { $ne: CHAIN_ID_MOONBEAM } },
        { recipient: { $ne: MOONBEAM_MRL_PRECOMPILE_ADDRESS } },
      ],
    });

    txnObject.status = TXN_STATUS.CONFIRMED;
    txnObject.signedVAABytes = signedVaa.vaaBytes;
    txnObject.signedVAAHash = vaaHash;

    if (redeemTx) {
      console.log(
        `VAA worker processing. transfer: ${txnObject.txn}, redemption: ${redeemTx.txn}, vaaHash: ${vaaHash}`,
      );
      txnObject.status = TXN_STATUS.REDEEMED;
      txnObject.redeemTxn = redeemTx.txn;
    } else {
      console.log(`VAA worker processing. transfer: ${txnObject.txn}, redeem not found, vaaHash: ${vaaHash}`);
    }

    txnObject.updated = new Date();

    await txnObject.save();
  } else {
    const txnCreated = new Date(txnObject.created);
    const now = new Date();
    const elapsedMilliseconds = Math.abs(txnCreated.getTime() - now.getTime());
    const elapsedMinutes = elapsedMilliseconds / (60 * 1000);
    const timeout = process.env.TXN_TIMEOUT ? Number(process.env.TXN_TIMEOUT) : 2880;

    if (elapsedMinutes >= timeout) {
      // else if reached timeout limit set to fail
      txnObject.status = TXN_STATUS.FAILED;
      txnObject.updated = new Date();

      await txnObject.save();
    }
  }
}
