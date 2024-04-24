import {
  ParachainBridgeType,
  PolkachainToken,
  PolkachainTokens,
  PolkachainXcGLMR,
  calculateMultilocationDerivativeAccount,
  formatAccountId,
  generateMRLTransactionHash,
  generateXCMTransactionHash,
  getMoonbeamTransactionHashByExtrinsic,
  getParachainAddressPrefix,
  getPolkadotProviderWithPolkaChainId,
  isPolkadotXCMV3,
  parseParachainTxHash,
  parsePolkachainTxPayload,
} from "../utils/polkadot";
import { ApiPromise } from "@polkadot/api";
import type { Vec } from "@polkadot/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import {
  CHAIN_ID_MOONBEAM,
  ChainId,
  getOriginalAssetEth,
  getSignedVAAHash,
  parseTokenTransferPayload,
  parseVaa,
  tryHexToNativeString,
  tryUint8ArrayToNative,
} from "../utils/wormhole";
import { decodeTx, getEthTransaction } from "../utils/ethereum";
import wormholeMRLTransferABI from "../utils/abi/WormholeMRLTransferABI.json";
import { ethers } from "ethers";
import {
  MOONBEAM_BATCH_PRECOMPILE_ADDRESS,
  MOONBEAM_MRL_PRECOMPILE_ADDRESS,
  Polkachain,
  MOONBEAM_PARACHAIN_ID,
  getEVMProviderWithWormholeChain,
  MOONBEAM_XCM_PRECOMPILE_ADDRESS,
  getChainInfoFromWormholeChain,
} from "../bridge";
import "@polkadot/api-augment";
import { ITxn, TransactionModel } from "../database/txnModel";
import { TXN_STATUS, TXN_TYPE } from "../utils/constants";
import { IToken, TokenModel } from "../database/tokenModel";
import { MrlRedemptionTransactionModel } from "../database/mrlRedemptionTxnModel";
import { MrlTransferTransactionModel } from "../database/mrlTransferTxnModel";
import { encodeAddress } from "@polkadot/util-crypto";
import { MESSAGE_STATUS, MRLBridgeMessageQueueModel } from "../database/mrlBridgeMessageQueueModel";
import { XCMBridgeMessageQueueModel, XCM_BRIDGE_TYPE } from "../database/xcmBridgeMessageQueueModel";
import { addTokensToDB, addTransactionsToDB } from "../database/helper";
import { getERC20Info } from "../utils/utils";
import { u8aToHex } from "@polkadot/util";

const avaiableChains = Object.keys(PolkachainTokens)
  .map((item) => parseInt(item))
  .concat([MOONBEAM_PARACHAIN_ID]);
const avaiableTokens = avaiableChains
  .map((chain) => PolkachainTokens[chain]?.map((token) => token.tokenAddressOnMoonbeam.toLowerCase()))
  .filter((item) => item != null)
  .flat();

let latestParachaianSubscriptionResponseTime: { [chainId: number]: number } = {};
let latestMoonbeamSubscriptionResponseTime = 0;

export function getLatestParachaianSubscriptionResponseTime(chainId: number) {
  return latestParachaianSubscriptionResponseTime[chainId];
}

export function getLatestMoonbeamSubscriptionResponseTime() {
  return latestMoonbeamSubscriptionResponseTime;
}

export function setLatestParachaianSubscriptionResponseTime(chainId: number, value: number) {
  latestParachaianSubscriptionResponseTime[chainId] = value;
}

export function setLatestMoonbeamSubscriptionResponseTime(value: number) {
  latestMoonbeamSubscriptionResponseTime = value;
}

async function createPolkadotTokenData(options: { polkachainId: Polkachain; tokenData: PolkachainToken }) {
  const { polkachainId, tokenData } = options;
  const { assetId, symbol, name, decimals } = tokenData;

  const exists = await TokenModel.exists({
    chainId: polkachainId,
    tokenAddress: assetId,
  });

  if (!exists) {
    const newToken = new TokenModel({
      chainId: polkachainId,
      tokenAddress: assetId,
      name,
      symbol,
      decimals,
    });

    await newToken.save();
  }
}

async function modifyExistedRedemptionRecordOrSaveToDB(options: {
  chainId: Polkachain;
  accountId: string;
  messageHash: string;
  parachainTxHash: string;
  vaaBytes: string;
}) {
  const { chainId, accountId, messageHash, vaaBytes, parachainTxHash } = options;
  const vaaBuffer = Buffer.from(vaaBytes, "base64");
  const vaa = parseVaa(vaaBuffer);
  const emitterAddress = tryHexToNativeString(
    vaa.emitterAddress.toString("hex"),
    vaa.emitterChain as ChainId,
  ).toLowerCase();

  const redeemTx = await TransactionModel.findOne({
    txnType: TXN_TYPE.REDEEM,
    destChainId: CHAIN_ID_MOONBEAM,
    recipient: MOONBEAM_MRL_PRECOMPILE_ADDRESS.toLowerCase(),
    emitterAddress,
    wormholeSequence: vaa.sequence.toString(),
  });
  const tokenTransferPayload = parseTokenTransferPayload(vaa.payload);
  const mrlPayload = await parsePolkachainTxPayload(tokenTransferPayload.tokenTransferPayload);

  if (redeemTx) {
    console.log(`[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] redeemTx found: `, redeemTx.txn);

    if (mrlPayload) {
      const tokenData = PolkachainTokens[mrlPayload.parachainId]?.find(
        (item) => item.tokenAddressOnMoonbeam.toLowerCase() === redeemTx.destTokenAddress.toLowerCase(),
      );

      redeemTx.destChainId = mrlPayload.parachainId;
      redeemTx.recipient = mrlPayload.accountId;
      redeemTx.txn = parachainTxHash;

      if (tokenData) {
        redeemTx.destTokenAddress = tokenData.assetId;

        await createPolkadotTokenData({ polkachainId: mrlPayload.parachainId, tokenData });
      }

      console.log(
        `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] redeemTx saved: `,
        JSON.stringify({
          destChainId: mrlPayload.parachainId,
          recipient: mrlPayload.accountId,
          txn: parachainTxHash,
          destTokenAddress: tokenData?.assetId,
        }),
      );

      await redeemTx.save();

      const vaaHash = getSignedVAAHash(vaaBuffer);
      const transferTxn = await TransactionModel.findOne({
        txnType: TXN_TYPE.TOKEN_BRIDGE,
        signedVAAHash: vaaHash,
      });

      if (transferTxn) {
        console.log(`[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] transferTx found: `, transferTxn.txn);

        transferTxn.status = TXN_STATUS.REDEEMED;
        transferTxn.redeemTxn = parachainTxHash;

        console.log(
          `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] transferTx saved: `,
          JSON.stringify({
            status: TXN_STATUS.REDEEMED,
            redeemTxn: parachainTxHash,
          }),
        );

        await transferTxn.save();
      }
    }
  } else {
    const exists = await MrlRedemptionTransactionModel.exists({ txn: parachainTxHash });

    if (!exists) {
      const mrlPayloadBytes = tokenTransferPayload.tokenTransferPayload.toString("base64");
      const newTxn = new MrlRedemptionTransactionModel({
        txn: parachainTxHash,
        emitterChain: vaa.emitterChain,
        emitterAddress,
        sequence: vaa.sequence.toString(),
        mrlPayloadBytes,
      });

      await newTxn.save();

      console.log(
        `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] MrlRedemptionTransaction saved: `,
        JSON.stringify({
          txn: parachainTxHash,
          emitterChain: vaa.emitterChain,
          emitterAddress,
          sequence: vaa.sequence.toString(),
          mrlPayloadBytes,
        }),
      );
    }
  }
}

async function modifyExistedTransferRecordOrSaveToDB(options: {
  chainId: Polkachain;
  accountId: string;
  messageHash: string;
  parachainTxHash: string;
  ethTxHash: string;
  transferSourceChainId: number;
  transferSender: string;
}) {
  const { chainId, accountId, messageHash, parachainTxHash, ethTxHash, transferSourceChainId, transferSender } =
    options;
  const transferTx = await TransactionModel.findOne({
    txnType: TXN_TYPE.TOKEN_BRIDGE,
    txn: ethTxHash.toLowerCase(),
    sourceChainId: CHAIN_ID_MOONBEAM,
  });

  if (transferTx) {
    console.log(`[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] transferTx found: `, transferTx.txn);

    transferTx.txn = parachainTxHash.toLowerCase();
    transferTx.sender = transferSender.toLowerCase();
    transferTx.sourceChainId = transferSourceChainId;

    const tokenData = PolkachainTokens[transferSourceChainId]?.find(
      (item) => item.tokenAddressOnMoonbeam.toLowerCase() === transferTx.sourceTokenAddress.toLowerCase(),
    );

    if (tokenData) {
      transferTx.sourceTokenAddress = tokenData.assetId;
      transferTx.isSourceNative = tokenData.isNative;

      await createPolkadotTokenData({ polkachainId: transferSourceChainId, tokenData });
    }

    console.log(
      `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] transferTx saved: `,
      JSON.stringify({
        parachainTxHash,
        ethTxHash,
        sourceChainId: transferSourceChainId,
        sender: transferSender,
        sourceTokenAddress: tokenData?.assetId,
        isSourceNative: tokenData?.isNative,
      }),
    );

    await transferTx.save();
  } else {
    const exists = await MrlTransferTransactionModel.exists({ txn: parachainTxHash });

    if (!exists) {
      const newTxn = new MrlTransferTransactionModel({
        txn: parachainTxHash,
        ethTxn: ethTxHash,
        sender: transferSender,
        sourceChainId: transferSourceChainId,
      });

      console.log(
        `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] MrlTransferTransaction saved: `,
        JSON.stringify({
          txn: parachainTxHash,
          ethTxn: ethTxHash,
          sender: transferSender,
          sourceChainId: transferSourceChainId,
        }),
      );

      await newTxn.save();
    }
  }
}

async function getMoonbeamTransactionHashByParachainHash(parachainHash: string) {
  const parsedParachainHash = parseParachainTxHash(parachainHash);

  if (
    parsedParachainHash?.bridgeType === ParachainBridgeType.XCM &&
    "sourceParachainBlockHash" in parsedParachainHash
  ) {
    const {
      sourceParachainId,
      sourceParachainBlockHash,
      sourceParachainExtrinsicHash,
      targetParachainId,
      targetParachainBlockHash,
      targetParachainExtrinsicHash,
    } = parsedParachainHash;
    if (sourceParachainId === MOONBEAM_PARACHAIN_ID) {
      return getMoonbeamTransactionHashByExtrinsic({
        blockHash: sourceParachainBlockHash,
        extrinsicHash: sourceParachainExtrinsicHash,
      });
    } else if (targetParachainId === MOONBEAM_PARACHAIN_ID) {
      return getMoonbeamTransactionHashByExtrinsic({
        blockHash: targetParachainBlockHash,
        extrinsicHash: targetParachainExtrinsicHash,
      });
    }
  }
}

async function createXCMBridgeRecord(options: {
  chainId: Polkachain;
  messageHash: string;
  accountId?: string;
  sourceChainId: Polkachain;
  sourceAssetId: string;
  sourceAccountId: string;
  targetChainId: Polkachain;
  targetAssetId: string;
  targetAccountId: string;
  parachainTxHash: string;
  tokenAmt: string;
}) {
  const {
    chainId,
    messageHash,
    accountId,
    sourceChainId,
    sourceAssetId,
    sourceAccountId,
    targetChainId,
    targetAssetId,
    targetAccountId,
    parachainTxHash,
    tokenAmt,
  } = options;
  const sourceToken =
    sourceChainId !== MOONBEAM_PARACHAIN_ID
      ? PolkachainTokens[sourceChainId].find((item) => item.assetId === sourceAssetId)
      : undefined;
  const targetToken =
    targetChainId !== MOONBEAM_PARACHAIN_ID
      ? PolkachainTokens[targetChainId].find((item) => item.assetId === targetAssetId)
      : undefined;
  const srcToken = sourceToken
    ? ({
        chainId: sourceChainId,
        tokenAddress: sourceToken.assetId,
        name: sourceToken.name,
        symbol: sourceToken.symbol,
        decimals: sourceToken.decimals,
      } as IToken | undefined)
    : sourceChainId === MOONBEAM_PARACHAIN_ID
    ? await getERC20Info(getEVMProviderWithWormholeChain(CHAIN_ID_MOONBEAM)!, sourceAssetId, CHAIN_ID_MOONBEAM)
    : undefined;
  const destToken = targetToken
    ? ({
        chainId: targetChainId,
        tokenAddress: targetToken.assetId,
        name: targetToken.name,
        symbol: targetToken.symbol,
        decimals: targetToken.decimals,
      } as IToken | undefined)
    : targetChainId === MOONBEAM_PARACHAIN_ID
    ? await getERC20Info(getEVMProviderWithWormholeChain(CHAIN_ID_MOONBEAM)!, targetAssetId, CHAIN_ID_MOONBEAM)
    : undefined;
  const originAsset =
    sourceChainId === MOONBEAM_PARACHAIN_ID
      ? await getOriginalAssetEth(
          getChainInfoFromWormholeChain(CHAIN_ID_MOONBEAM).wormholeTokenBridge,
          getEVMProviderWithWormholeChain(CHAIN_ID_MOONBEAM)!,
          sourceAssetId,
          CHAIN_ID_MOONBEAM,
        )
      : undefined;
  const tokenInfo = {
    isSourceNative: sourceToken ? sourceToken.isNative : !originAsset?.isWrapped,
    unwrappedSourceTokenAddress:
      sourceToken?.oringinAddress ||
      (originAsset ? tryUint8ArrayToNative(originAsset.assetAddress, originAsset.chainId) : undefined),
    unwrappedSourceChainId: sourceToken?.originChainId || originAsset?.chainId,
    sourceTokenAddress: sourceAssetId,
    destTokenAddress: targetAssetId,
  };
  const denormAmt =
    srcToken?.decimals && srcToken.decimals > 8
      ? ethers.utils
          .parseUnits(
            ethers.FixedNumber.fromString(ethers.utils.formatUnits(tokenAmt, srcToken.decimals), srcToken.decimals)
              .round(8)
              .toString(),
            8,
          )
          .toString()
      : tokenAmt;
  const moonbeamTxn = await getMoonbeamTransactionHashByParachainHash(parachainTxHash);
  const transferTxn = sourceChainId === MOONBEAM_PARACHAIN_ID ? moonbeamTxn : parachainTxHash;
  const redemptionTxn = targetChainId === MOONBEAM_PARACHAIN_ID ? moonbeamTxn : parachainTxHash;

  if (!transferTxn || !redemptionTxn) {
    console.error(
      `[CHAIN: ${chainId}, ID: ${
        (accountId ? accountId + "," : "") + messageHash
      }] can't find txns. transfer txn: ${transferTxn}, redemption txn: ${redemptionTxn}`,
    );
    return;
  }

  const transferTx = {
    txnType: TXN_TYPE.TOKEN_BRIDGE,
    txn: transferTxn,
    sender: sourceAccountId,
    recipient: targetAccountId,
    ...tokenInfo,
    sourceChainId: sourceChainId === MOONBEAM_PARACHAIN_ID ? CHAIN_ID_MOONBEAM : sourceChainId,
    destChainId: targetChainId === MOONBEAM_PARACHAIN_ID ? CHAIN_ID_MOONBEAM : targetChainId,
    tokenAmt: denormAmt,
    redeemTxn: redemptionTxn,
    status: TXN_STATUS.REDEEMED,
  } as ITxn;

  const redeemTx = {
    txnType: TXN_TYPE.REDEEM,
    txn: redemptionTxn,
    sender: sourceAccountId,
    recipient: targetAccountId,
    ...tokenInfo,
    sourceChainId: sourceChainId === MOONBEAM_PARACHAIN_ID ? CHAIN_ID_MOONBEAM : sourceChainId,
    destChainId: targetChainId === MOONBEAM_PARACHAIN_ID ? CHAIN_ID_MOONBEAM : targetChainId,
    tokenAmt: denormAmt,
    status: TXN_STATUS.CONFIRMED,
  } as ITxn;

  await addTransactionsToDB([transferTx, redeemTx]);

  console.log(
    `[CHAIN: ${chainId}, ID: ${
      (accountId ? accountId + "," : "") + messageHash
    }] parachain transfer and redemption transaction created. txn: ${transferTx.txn}`,
  );

  if (srcToken || destToken) {
    console.log(
      `[CHAIN: ${chainId}, ID: ${
        (accountId ? accountId + "," : "") + messageHash
      }] parachain tokens created. srcToken chain: ${srcToken?.chainId}, srcToken address: ${
        srcToken?.tokenAddress
      }, destToken chain: ${destToken?.chainId}, destToken address: ${destToken?.tokenAddress}`,
    );

    await addTokensToDB([srcToken, destToken].filter((item) => item != null) as IToken[]);
  }
}

async function getVaaAndTransactionHashFromEthereumExecutedEvent(ethereumExecutedEvent: EventRecord | undefined) {
  if (ethereumExecutedEvent) {
    if (
      (ethereumExecutedEvent.event.data as any).to.toHex().toLowerCase() ===
      MOONBEAM_MRL_PRECOMPILE_ADDRESS.toLowerCase()
    ) {
      const transactionHash = (ethereumExecutedEvent.event.data as any).transactionHash.toHex();

      let transaction: ethers.providers.TransactionResponse | undefined;
      try {
        console.log("getVaaAndTransactionHashFromEthereumExecutedEvent3", transactionHash);

        transaction = await getEthTransaction({ chainId: CHAIN_ID_MOONBEAM, txHash: transactionHash });
      } catch (e) {
        console.error("failed to get moonbeam transaction", transactionHash, e);
      }

      const decodeData = transaction?.data ? decodeTx([wormholeMRLTransferABI], transaction?.data) : undefined;

      if (decodeData) {
        if (decodeData.functionFragment.name === "wormholeTransferERC20") {
          const vaaHex = decodeData.args[0];
          const vaaBytes = ethers.utils.arrayify(vaaHex);
          const vaaParsed = parseVaa(vaaBytes);

          return { vaa: vaaParsed, vaaBytes, transactionHash };
        }
      }
    }
  }
}

async function getExtrinsicHashByBlockHashAndMessageHash(options: {
  api: ApiPromise;
  blockHash: string;
  messageHash: string;
  events: Vec<EventRecord>;
}) {
  const { api, blockHash, messageHash, events } = options;

  const block = await api.rpc.chain.getBlock(blockHash);
  const extrinsicIndex = block.block.extrinsics.findIndex((item, index) => {
    const extrinsicEvents = events.filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index));
    const eventIncludingMessageHash = extrinsicEvents.find(
      (item) => (item.event.data as any)?.messageHash?.toHex() === messageHash,
    );

    return eventIncludingMessageHash != null;
  });
  const extrinsic = block.block.extrinsics[extrinsicIndex];

  return { extrinsicHash: extrinsic?.hash.toHex() };
}

async function handleMoonbeamMessage(options: { api: ApiPromise; events: Vec<EventRecord> }) {
  const { api, events } = options;

  const xcmpEvent = events.find((item) => item.event.section === "xcmpQueue");
  const sameExtrinsicEvents = events.filter((item) => {
    return (
      item.phase.isApplyExtrinsic &&
      xcmpEvent?.phase.isApplyExtrinsic &&
      item.phase.asApplyExtrinsic.eq(xcmpEvent?.phase.asApplyExtrinsic)
    );
  });
  const xcmpEvents = sameExtrinsicEvents.filter((item) => item.event.section === "xcmpQueue");
  const transferredMultiAssetsEvent = sameExtrinsicEvents.find(
    (item) => item.event.section === "xTokens" && item.event.method === "TransferredMultiAssets",
  );
  const ethereumExecutedEvents = sameExtrinsicEvents.filter(
    (item) => item.event.section === "ethereum" && item.event.method === "Executed",
  );
  const tokenTransferExecutedEvent =
    ethereumExecutedEvents && ethereumExecutedEvents.length > 0 ? ethereumExecutedEvents.reverse()[0] : undefined;

  const isMRLRedemption: boolean =
    xcmpEvent != null &&
    tokenTransferExecutedEvent != null &&
    (tokenTransferExecutedEvent.event.data as any)?.to?.toHex() === MOONBEAM_MRL_PRECOMPILE_ADDRESS.toLowerCase();
  const xcmSentEvent = xcmpEvents.find(
    (item) => item.event.section === "xcmpQueue" && item.event.method === "XcmpMessageSent",
  );
  const xcmSentEventMessageHash = (xcmSentEvent?.event.data as any)?.messageHash?.toHex();
  const receivedXcmEvent = xcmpEvents.reverse()[0];
  const receivedXcmMessageHash = (receivedXcmEvent?.event.data as any)?.messageHash?.toHex();

  const isTokenExists: boolean = avaiableTokens.includes(
    (tokenTransferExecutedEvent?.event.data as any)?.to?.toHex().toLowerCase(),
  );

  // it's not 100% guaranteed, because the batch precompile can be used to do any transactions
  // so if we need more accurate detection, we should check the transaction with an LogPublished event
  const isMRLTransfer =
    xcmpEvents.length === 2 &&
    ethereumExecutedEvents.length === 2 &&
    tokenTransferExecutedEvent != null &&
    (tokenTransferExecutedEvent.event.data as any)?.to?.toHex() === MOONBEAM_BATCH_PRECOMPILE_ADDRESS.toLowerCase();
  const isXCMTransfer =
    xcmpEvents.length === 1 &&
    ethereumExecutedEvents.length === 1 &&
    tokenTransferExecutedEvent != null &&
    (tokenTransferExecutedEvent.event.data as any)?.to?.toHex() === MOONBEAM_XCM_PRECOMPILE_ADDRESS.toLowerCase();

  const isXCMBridgeOrRedemption =
    xcmpEvents.length >= 1 && !isMRLTransfer && !isMRLRedemption && !isXCMTransfer && isTokenExists;
  const isXCMRedemption = isXCMBridgeOrRedemption && !xcmSentEventMessageHash;

  const moonbeamTargetAccountU8a = isXCMRedemption
    ? ((
        sameExtrinsicEvents.find((item) => item.event.section === "balances" && item.event.method === "Deposit")?.event
          ?.data as any
      )?.who?.asAccountKey20?.key as Uint8Array)
    : undefined;
  const moonbeamTargetAccount = moonbeamTargetAccountU8a ? u8aToHex(moonbeamTargetAccountU8a) : undefined;

  const accountId = isMRLTransfer
    ? (tokenTransferExecutedEvent.event.data as any)?.from?.toHex()
    : isMRLRedemption
    ? await formatAccountId(
        (transferredMultiAssetsEvent?.event.data as any)[3]?.interior?.asX2[1]?.asAccountId32?.id,
        (transferredMultiAssetsEvent?.event.data as any)[3]?.interior?.asX2[0]?.asParachain,
      )
    : isXCMTransfer
    ? u8aToHex((transferredMultiAssetsEvent?.event.data as any).sender)
    : isXCMRedemption
    ? moonbeamTargetAccount
    : undefined;

  const messageHash = (xcmpEvent?.event.data as any)?.messageHash?.toHex();
  const blockHash = events.createdAtHash?.toHex();

  if (isMRLTransfer || isMRLRedemption) {
    if (!blockHash) {
      console.error(new Error(`fail to find block hash on moonbeam.`));
    } else if (!messageHash) {
      console.error(new Error(`empty messageHash on moonbeam, blockHash: ${blockHash}`));
    } else if (!accountId) {
      console.error(new Error(`empty accountId on moonbeam, blockHash: ${blockHash}, messageHash: ${messageHash}`));
    } else {
      console.log(
        `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${accountId + "," + messageHash}] ${
          isMRLTransfer ? "MRL Transfer" : "MRL Redemption"
        } received on moonbeam. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
      );

      const { extrinsicHash: moonbeamExtrinsicHash } = await getExtrinsicHashByBlockHashAndMessageHash({
        api,
        blockHash,
        messageHash,
        events,
      });

      const xcmpMessage = await MRLBridgeMessageQueueModel.findOne(
        {
          accountId,
          messageHash,
        },
        null,
        { sort: { created: -1 } },
      );

      const isXcmpFailed = xcmpEvents.some((item) => item.event.method === "Fail");
      // transfer has two xcmp events and redemption has one, and they all need to be successful
      const isSuccess = isMRLTransfer
        ? xcmpEvents.length === 2 && !isXcmpFailed && moonbeamExtrinsicHash
        : !isXcmpFailed && moonbeamExtrinsicHash;

      // if failed, save failed result and exist.
      if (!isSuccess) {
        console.error(
          new Error(
            `xcmpQueue failed on moonbeam. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
          ),
        );

        if (xcmpMessage) {
          xcmpMessage.moonbeamBlockHash = blockHash;
          xcmpMessage.xcmStatus = MESSAGE_STATUS.FAILED;

          await xcmpMessage.save();
        } else {
          const message = new MRLBridgeMessageQueueModel({
            accountId,
            messageHash,
            moonbeamBlockHash: blockHash,
            xcmStatus: MESSAGE_STATUS.FAILED,
          });

          await message.save();
        }
      } else {
        const { parachainId, parachainBlockHash, parachainExtrinsicHash, transferSender, transferSourceChainId } =
          xcmpMessage || {};

        if (isMRLTransfer) {
          const transferTxHash = (tokenTransferExecutedEvent.event.data as any)?.transactionHash?.toHex();

          if (parachainId && parachainBlockHash && parachainExtrinsicHash && transferSender && transferSourceChainId) {
            const parachainTxHash = generateMRLTransactionHash({
              messageHash,
              moonbeamBlockHash: blockHash,
              moonbeamTransactionHash: transferTxHash,
              moonbeamExtrinsicHash,
              parachainId,
              parachainExtrinsicHash,
              parachainBlockHash,
            });

            console.log(
              `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                accountId + "," + messageHash
              }] moombeam generate transfer transaction hash. ${JSON.stringify({
                messageHash,
                moonbeamBlockHash: blockHash,
                moonbeamTransactionHash: transferTxHash,
                moonbeamExtrinsicHash,
                parachainExtrinsicHash,
                parachainBlockHash,
              })}`,
            );

            await modifyExistedTransferRecordOrSaveToDB({
              chainId: MOONBEAM_PARACHAIN_ID,
              accountId,
              messageHash,
              parachainTxHash,
              ethTxHash: transferTxHash,
              transferSender,
              transferSourceChainId,
            });

            if (xcmpMessage) {
              xcmpMessage.moonbeamBlockHash = blockHash;
              xcmpMessage.moonbeamExtrinsicHash = moonbeamExtrinsicHash;
              xcmpMessage.moonbeamTransactionHash = transferTxHash;
              xcmpMessage.xcmStatus = MESSAGE_STATUS.SUCCESS;

              await xcmpMessage.save();

              console.log(
                `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                  accountId + "," + messageHash
                }] moonbeam transfer xcmp message mark as done. messageHash: ${xcmpMessage.messageHash}, accountId: ${
                  xcmpMessage.accountId
                }, xcmStatus: ${xcmpMessage.xcmStatus}`,
              );
            }
          } else {
            const message = new MRLBridgeMessageQueueModel({
              accountId,
              messageHash,
              moonbeamBlockHash: blockHash,
              moonbeamExtrinsicHash,
              moonbeamTransactionHash: transferTxHash,
              xcmStatus: MESSAGE_STATUS.SUCCESS,
            });

            await message.save();

            console.log(
              `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                accountId + "," + messageHash
              }] moonbeam transfer xcmp message saved. ${JSON.stringify({
                accountId,
                messageHash,
                moonbeamBlockHash: blockHash,
                moonbeamExtrinsicHash,
                moonbeamTransactionHash: transferTxHash,
                xcmStatus: MESSAGE_STATUS.SUCCESS,
              })}`,
            );
          }
        } else if (isMRLRedemption) {
          const vaaResult = await getVaaAndTransactionHashFromEthereumExecutedEvent(tokenTransferExecutedEvent);
          console.log("getVaaAndTransactionHashFromEthereumExecutedEvent", vaaResult);

          if (vaaResult) {
            const vaaBytes = Buffer.from(vaaResult.vaaBytes).toString("base64");

            if (parachainId && parachainBlockHash && parachainExtrinsicHash) {
              const parachainTxHash = generateMRLTransactionHash({
                messageHash,
                moonbeamBlockHash: blockHash,
                moonbeamTransactionHash: vaaResult.transactionHash,
                moonbeamExtrinsicHash,
                parachainId,
                parachainExtrinsicHash,
                parachainBlockHash,
              });

              console.log(
                `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                  accountId + "," + messageHash
                }] moombeam generate redemption transaction hash. ${JSON.stringify({
                  messageHash,
                  moonbeamBlockHash: blockHash,
                  moonbeamTransactionHash: vaaResult.transactionHash,
                  moonbeamExtrinsicHash,
                  parachainExtrinsicHash,
                  parachainBlockHash,
                })}`,
              );

              await modifyExistedRedemptionRecordOrSaveToDB({
                chainId: MOONBEAM_PARACHAIN_ID,
                accountId,
                messageHash,
                parachainTxHash,
                vaaBytes,
              });

              if (xcmpMessage) {
                xcmpMessage.moonbeamBlockHash = blockHash;
                xcmpMessage.moonbeamExtrinsicHash = moonbeamExtrinsicHash;
                xcmpMessage.moonbeamTransactionHash = vaaResult.transactionHash;
                xcmpMessage.vaaBytes = vaaBytes;
                xcmpMessage.xcmStatus =
                  xcmpEvent?.event.method === "Fail" ? MESSAGE_STATUS.FAILED : MESSAGE_STATUS.SUCCESS;

                await xcmpMessage.save();

                console.log(
                  `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                    accountId + "," + messageHash
                  }] moonbeam redemption xcmp message mark as done. messageHash: ${
                    xcmpMessage.messageHash
                  }, accountId: ${xcmpMessage.accountId}, xcmStatus: ${xcmpMessage.xcmStatus}`,
                );
              }
            } else {
              const message = new MRLBridgeMessageQueueModel({
                accountId,
                messageHash,
                moonbeamBlockHash: blockHash,
                moonbeamExtrinsicHash,
                moonbeamTransactionHash: vaaResult.transactionHash,
                vaaBytes,
                xcmStatus: xcmpEvent?.event.method === "Fail" ? MESSAGE_STATUS.FAILED : MESSAGE_STATUS.SUCCESS,
              });

              await message.save();

              console.log(
                `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
                  accountId + "," + messageHash
                }] moonbeam redemption xcmp message saved. ${JSON.stringify({
                  accountId,
                  messageHash,
                  moonbeamBlockHash: blockHash,
                  moonbeamExtrinsicHash,
                  moonbeamTransactionHash: vaaResult.transactionHash,
                  vaaBytes,
                  xcmStatus: xcmpEvent?.event.method === "Fail" ? MESSAGE_STATUS.FAILED : MESSAGE_STATUS.SUCCESS,
                })}`,
              );
            }
          }
        }
      }
    }
  } else if (isXCMTransfer) {
    if (!blockHash) {
      console.error(new Error(`fail to find block hash on moonbeam.`));
    } else if (!messageHash) {
      console.error(new Error(`empty messageHash on moonbeam, blockHash: ${blockHash}`));
    } else if (!accountId) {
      console.error(new Error(`empty accountId on moonbeam, blockHash: ${blockHash}, messageHash: ${messageHash}`));
    } else {
      console.log(
        `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
          accountId + "," + messageHash
        }] XCM transfer received on moonbeam. blockHash: ${blockHash}, messageHash: ${messageHash}`,
      );

      const { extrinsicHash } = await getExtrinsicHashByBlockHashAndMessageHash({
        api,
        blockHash,
        messageHash,
        events,
      });

      const xcmMessage = await XCMBridgeMessageQueueModel.findOne(
        { type: XCM_BRIDGE_TYPE.Redemption, messageHash: xcmSentEventMessageHash },
        null,
        {
          sort: { created: -1 },
        },
      );

      const transferredMultiAssetsEventAmount = (
        transferredMultiAssetsEvent?.event.data as any
      )?.assets[1]?.fun?.asFungible.toString() as string;

      const moonbeamSourceTokenAddressU8a = (transferredMultiAssetsEvent?.event.data as any)?.assets[1]?.id?.asConcrete
        ?.interior?.asX2[1]?.asAccountKey20?.key;

      const moonbeamSourceTokenAddress = u8aToHex(moonbeamSourceTokenAddressU8a);

      if (xcmMessage) {
        if (
          xcmMessage.messageHash &&
          xcmMessage.parachainId &&
          xcmMessage.parachainBlockHash &&
          xcmMessage.parachainExtrinsicHash
        ) {
          const parachainTxHashData = {
            sourceMessageHash: xcmSentEventMessageHash,
            sourceAssetId: moonbeamSourceTokenAddress,
            sourceParachainId: MOONBEAM_PARACHAIN_ID,
            sourceParachainBlockHash: blockHash,
            sourceParachainExtrinsicHash: extrinsicHash,
            targetMessageHash: xcmMessage.messageHash,
            targetAssetId: xcmMessage.assetId,
            targetParachainId: xcmMessage.parachainId,
            targetParachainBlockHash: xcmMessage.parachainBlockHash,
            targetParachainExtrinsicHash: xcmMessage.parachainExtrinsicHash,
          };

          const parachainTxHash = generateXCMTransactionHash(parachainTxHashData);

          console.log(
            `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${
              accountId + "," + messageHash
            }] xcm transaction hash generated. ${JSON.stringify(parachainTxHashData)}`,
          );

          await createXCMBridgeRecord({
            chainId: MOONBEAM_PARACHAIN_ID,
            messageHash: xcmSentEventMessageHash,
            sourceChainId: MOONBEAM_PARACHAIN_ID,
            sourceAssetId: moonbeamSourceTokenAddress,
            sourceAccountId: accountId,
            targetChainId: xcmMessage.parachainId,
            targetAssetId: xcmMessage.assetId,
            targetAccountId: xcmMessage.accountId,
            parachainTxHash,
            tokenAmt: transferredMultiAssetsEventAmount,
          });

          xcmMessage.relatedMessageHash = xcmSentEventMessageHash;

          await xcmMessage.save();
        }
      } else {
        const redemptionMessageData = {
          type: XCM_BRIDGE_TYPE.Redemption,
          messageHash: xcmSentEventMessageHash,
          relatedMessageHash: xcmSentEventMessageHash,
          xcmStatus: MESSAGE_STATUS.SUCCESS,
        };
        const newRedemptionMessage = new XCMBridgeMessageQueueModel(redemptionMessageData);

        await newRedemptionMessage.save();

        console.log(
          `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm redemption message saved. ${JSON.stringify(
            redemptionMessageData,
          )}`,
        );
      }

      const transferMessageData = {
        type: XCM_BRIDGE_TYPE.Transfer,
        messageHash: xcmSentEventMessageHash,
        accountId,
        parachainId: MOONBEAM_PARACHAIN_ID,
        assetId: moonbeamSourceTokenAddress,
        parachainBlockHash: blockHash,
        parachainExtrinsicHash: extrinsicHash,
        amount: transferredMultiAssetsEventAmount,
        relatedMessageHash: xcmSentEventMessageHash,
        xcmStatus: MESSAGE_STATUS.SUCCESS,
      };

      const newTransferMessage = new XCMBridgeMessageQueueModel(transferMessageData);

      await newTransferMessage.save();
    }
  } else if (isXCMBridgeOrRedemption) {
    if (!blockHash) {
      console.error(new Error(`fail to find block hash on moonbeam.`));
    } else if (!messageHash) {
      console.error(new Error(`empty messageHash on moonbeam, blockHash: ${blockHash}`));
    } else {
      console.log(
        `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] XCM bridge or redemption received on moonbeam. blockHash: ${blockHash}, messageHash: ${messageHash}`,
      );

      const { extrinsicHash } = await getExtrinsicHashByBlockHashAndMessageHash({
        api,
        blockHash,
        messageHash,
        events,
      });

      const transferMessage = await XCMBridgeMessageQueueModel.findOne(
        { type: XCM_BRIDGE_TYPE.Transfer, messageHash: receivedXcmMessageHash },
        null,
        {
          sort: { created: -1 },
        },
      );
      const redemptionMessage = await XCMBridgeMessageQueueModel.findOne(
        { type: XCM_BRIDGE_TYPE.Redemption, messageHash: xcmSentEventMessageHash },
        null,
        {
          sort: { created: -1 },
        },
      );

      if (isXCMRedemption) {
        if (
          transferMessage &&
          transferMessage.messageHash &&
          transferMessage.parachainId &&
          transferMessage.parachainBlockHash &&
          transferMessage.parachainExtrinsicHash &&
          transferMessage.assetId &&
          transferMessage.amount
        ) {
          const moonbeamTargetAccountU8a = (
            sameExtrinsicEvents.find((item) => item.event.section === "balances" && item.event.method === "Deposit")
              ?.event?.data as any
          )?.who as Uint8Array;
          const moonbeamTargetAccount = u8aToHex(moonbeamTargetAccountU8a);
          const moonbeamTokenAddress = (tokenTransferExecutedEvent?.event.data as any)?.to?.toHex().toLowerCase();

          const parachainTxHashData = {
            sourceMessageHash: transferMessage.messageHash,
            sourceAssetId: transferMessage.assetId,
            sourceParachainId: transferMessage.parachainId,
            sourceParachainBlockHash: transferMessage.parachainBlockHash,
            sourceParachainExtrinsicHash: transferMessage.parachainExtrinsicHash,
            targetMessageHash: receivedXcmMessageHash,
            targetAssetId: moonbeamTokenAddress,
            targetParachainId: MOONBEAM_PARACHAIN_ID,
            targetParachainBlockHash: blockHash,
            targetParachainExtrinsicHash: extrinsicHash,
          };
          const parachainTxHash = generateXCMTransactionHash(parachainTxHashData);

          console.log(
            `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm transaction hash generated. ${JSON.stringify(
              parachainTxHashData,
            )}`,
          );

          await createXCMBridgeRecord({
            chainId: MOONBEAM_PARACHAIN_ID,
            messageHash: receivedXcmMessageHash,
            sourceChainId: transferMessage.parachainId,
            sourceAssetId: transferMessage.assetId,
            sourceAccountId: transferMessage.accountId,
            targetChainId: MOONBEAM_PARACHAIN_ID,
            targetAssetId: moonbeamTokenAddress,
            targetAccountId: moonbeamTargetAccount,
            parachainTxHash,
            tokenAmt: transferMessage.amount,
          });

          transferMessage.relatedMessageHash = receivedXcmMessageHash;

          await transferMessage.save();

          const redemptionMessageData = {
            type: XCM_BRIDGE_TYPE.Redemption,
            messageHash: receivedXcmMessageHash,
            accountId: moonbeamTargetAccount,
            parachainId: MOONBEAM_PARACHAIN_ID,
            assetId: moonbeamTokenAddress,
            parachainBlockHash: blockHash,
            parachainExtrinsicHash: extrinsicHash,
            amount: transferMessage.amount,
            relatedMessageHash: receivedXcmMessageHash,
            xcmStatus: MESSAGE_STATUS.SUCCESS,
          };
          const newTransferMessage = new XCMBridgeMessageQueueModel(redemptionMessageData);

          await newTransferMessage.save();
        }
      } else if (transferMessage && redemptionMessage) {
        if (
          transferMessage.messageHash &&
          transferMessage.parachainId &&
          transferMessage.parachainBlockHash &&
          transferMessage.parachainExtrinsicHash &&
          transferMessage.assetId &&
          transferMessage.amount
        ) {
          const parachainTxHashData = {
            sourceMessageHash: transferMessage.messageHash,
            sourceAssetId: transferMessage.assetId,
            sourceParachainId: transferMessage.parachainId,
            sourceParachainBlockHash: transferMessage.parachainBlockHash,
            sourceParachainExtrinsicHash: transferMessage.parachainExtrinsicHash,
            targetMessageHash: redemptionMessage!.messageHash,
            targetAssetId: redemptionMessage!.assetId,
            targetParachainId: redemptionMessage!.parachainId,
            targetParachainBlockHash: redemptionMessage!.parachainBlockHash,
            targetParachainExtrinsicHash: redemptionMessage!.parachainExtrinsicHash,
          };
          const parachainTxHash = generateXCMTransactionHash(parachainTxHashData);

          console.log(
            `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm transaction hash generated. ${JSON.stringify(
              parachainTxHashData,
            )}`,
          );

          await createXCMBridgeRecord({
            chainId: MOONBEAM_PARACHAIN_ID,
            messageHash: receivedXcmMessageHash,
            sourceChainId: transferMessage.parachainId,
            sourceAssetId: transferMessage.assetId,
            sourceAccountId: transferMessage.accountId,
            targetChainId: redemptionMessage!.parachainId,
            targetAssetId: redemptionMessage!.assetId,
            targetAccountId: redemptionMessage!.accountId,
            parachainTxHash,
            tokenAmt: transferMessage.amount,
          });

          transferMessage.relatedMessageHash = xcmSentEventMessageHash;

          await transferMessage.save();

          if (redemptionMessage) {
            redemptionMessage.relatedMessageHash = receivedXcmMessageHash;

            await redemptionMessage.save();
          }
        }
      } else if (!transferMessage && !redemptionMessage) {
        const transferMessageData = {
          type: XCM_BRIDGE_TYPE.Transfer,
          messageHash: receivedXcmMessageHash,
          relatedMessageHash: xcmSentEventMessageHash,
          xcmStatus: MESSAGE_STATUS.SUCCESS,
        };
        const newTransferMessage = new XCMBridgeMessageQueueModel(transferMessageData);
        const redemptionMessageData = {
          type: XCM_BRIDGE_TYPE.Redemption,
          messageHash: xcmSentEventMessageHash,
          relatedMessageHash: receivedXcmMessageHash,
          xcmStatus: MESSAGE_STATUS.SUCCESS,
        };
        const newRedemptionMessage = new XCMBridgeMessageQueueModel(redemptionMessageData);

        await XCMBridgeMessageQueueModel.insertMany([newTransferMessage, newRedemptionMessage]);

        console.log(
          `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm transfer and redemption message saved. transfer data: ${JSON.stringify(
            transferMessageData,
          )}, redemption data: ${JSON.stringify(redemptionMessageData)}`,
        );
      } else if (transferMessage) {
        transferMessage.relatedMessageHash = xcmSentEventMessageHash;

        await transferMessage.save();

        const redemptionMessageData = {
          type: XCM_BRIDGE_TYPE.Redemption,
          messageHash: xcmSentEventMessageHash,
          relatedMessageHash: transferMessage.messageHash,
          xcmStatus: MESSAGE_STATUS.SUCCESS,
        };
        const redemptionMessage = new XCMBridgeMessageQueueModel(redemptionMessageData);

        await redemptionMessage.save();

        console.log(
          `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm redemption message saved. ${JSON.stringify(
            redemptionMessageData,
          )}`,
        );
      } else if (redemptionMessage) {
        redemptionMessage.relatedMessageHash = receivedXcmMessageHash;

        await redemptionMessage.save();

        const transferMessageData = {
          type: XCM_BRIDGE_TYPE.Transfer,
          messageHash: receivedXcmMessageHash,
          relatedMessageHash: redemptionMessage.messageHash,
          xcmStatus: MESSAGE_STATUS.SUCCESS,
        };
        const transferMessage = new XCMBridgeMessageQueueModel(transferMessageData);

        console.log(
          `[CHAIN: ${MOONBEAM_PARACHAIN_ID}, ID: ${messageHash}] xcm transfer message saved. ${JSON.stringify(
            transferMessageData,
          )}`,
        );

        await transferMessage.save();
      }
    }
  }
}

async function handlePolkachainMessage(options: {
  chainId: Polkachain;
  api: ApiPromise;
  events: Vec<EventRecord>;
  addressPrefix?: number;
}) {
  const { chainId, api, events, addressPrefix } = options;

  const xcmpEvent = events.find((item) => {
    return item.event.section === "xcmpQueue";
  });
  const sameExtrinsicEvents = events.filter((item) => {
    return (
      item.phase.isApplyExtrinsic &&
      xcmpEvent?.phase.isApplyExtrinsic &&
      item.phase.asApplyExtrinsic.eq(xcmpEvent?.phase.asApplyExtrinsic)
    );
  });
  const transferredMultiAssetsEvent = sameExtrinsicEvents.find(
    (item) => item.event.section === "xTokens" && item.event.method === "TransferredMultiAssets",
  );
  const assetsIssuedEvents =
    transferredMultiAssetsEvent == null
      ? sameExtrinsicEvents.filter((item) =>
          isPolkadotXCMV3(chainId)
            ? item.event.section === "tokens" && item.event.method === "Deposited"
            : item.event.section === "assets" && item.event.method === "Issued",
        )
      : null;
  const polkadotXcmSentEvent = sameExtrinsicEvents.find(
    (item) => item.event.section === "polkadotXcm" && item.event.method === "Sent",
  );
  const transferredMultiAssetsEventRecipientChain = (
    transferredMultiAssetsEvent?.event.data as any
  )?.dest?.interior?.asX2[0]?.asParachain?.toNumber() as Polkachain;
  const transferredMultiAssetsEventTokenLocation = (
    transferredMultiAssetsEvent?.event.data as any
  )?.assets[1]?.id?.asConcrete?.toJSON() as any;
  const transferredMultiAssetsEventAmount = (
    transferredMultiAssetsEvent?.event.data as any
  )?.assets[1]?.fun?.asFungible.toString() as string;
  const transferToken = getParachainTokenByLocation(transferredMultiAssetsEventTokenLocation, chainId);
  const redemptionAssetIds: string[] = assetsIssuedEvents
    ? assetsIssuedEvents
        .map((item) => {
          try {
            return isPolkadotXCMV3(chainId)
              ? chainId === Polkachain.Interlay
                ? (item?.event.data as any)?.currencyId?.asForeignAsset?.toString()
                : chainId === Polkachain.PeaqAgung
                ? (item?.event.data as any)?.currencyId?.asToken.toString()
                : (item?.event.data as any)?.currencyId?.toString()
              : (item?.event.data as any)?.assetId?.toString();
          } catch (e) {}
        })
        .filter((item) => item != null)
    : [];
  const redemptionToken = getParachainTokenByAssetIds(redemptionAssetIds, chainId);

  const isMRLTransfer = xcmpEvent != null && polkadotXcmSentEvent != null && transferredMultiAssetsEvent != null;
  const isXCMTransfer: boolean =
    xcmpEvent != null &&
    transferredMultiAssetsEvent != null &&
    avaiableChains.includes(transferredMultiAssetsEventRecipientChain) &&
    transferToken != null;
  const isRedemption = xcmpEvent != null && redemptionToken != null;
  const isXCMRedemption = isRedemption && checkGLMRExistsOnAssetIds(redemptionAssetIds, chainId);
  const isMRLRedemption = isRedemption && !isXCMRedemption;

  const accountId = isMRLTransfer
    ? calculateMultilocationDerivativeAccount({
        address: encodeAddress((transferredMultiAssetsEvent?.event.data as any).sender, addressPrefix),
        chainId,
        isParent: true,
      })
    : isXCMTransfer
    ? encodeAddress((transferredMultiAssetsEvent?.event.data as any).sender, addressPrefix)
    : isRedemption && assetsIssuedEvents
    ? encodeAddress(
        isPolkadotXCMV3(chainId)
          ? (assetsIssuedEvents[0]?.event.data as any).who
          : (assetsIssuedEvents[0]?.event.data as any).owner,
        addressPrefix,
      )
    : undefined;
  const messageHash = (xcmpEvent?.event.data as any)?.messageHash?.toHex();
  const blockHash = events.createdAtHash?.toHex();

  if (isMRLTransfer || isMRLRedemption) {
    if (!blockHash) {
      console.error(new Error(`fail to find block hash on chainId: ${chainId}.`));
    } else if (!messageHash) {
      console.error(new Error(`empty messageHash on chainId: ${chainId}. blockHash: ${blockHash}`));
    } else if (!accountId) {
      console.error(
        new Error(`empty accountId on chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}`),
      );
    } else {
      console.log(
        `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] ${
          isMRLTransfer ? "MRL Transfer" : "MRL Redemption"
        } received. chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
      );

      const { extrinsicHash: parachainExtrinsicHash } = await getExtrinsicHashByBlockHashAndMessageHash({
        api,
        blockHash,
        messageHash,
        events,
      });

      const xcmpMessage = await MRLBridgeMessageQueueModel.findOne(
        {
          accountId,
          messageHash,
        },
        null,
        { sort: { created: -1 } },
      );

      const xcmpEvents = sameExtrinsicEvents.filter((item) => {
        return item.event.section === "xcmpQueue";
      });
      const isXcmpFailed = xcmpEvents.some((item) => item.event.method === "Fail");
      // transfer has two xcmp events and redemption has one, and they all need to be successful
      const isSuccess = isMRLTransfer
        ? xcmpEvents.length === 2 && !isXcmpFailed && parachainExtrinsicHash
        : !isXcmpFailed && parachainExtrinsicHash;

      // if failed, save failed result and exist.
      if (!isSuccess) {
        console.error(
          new Error(
            `xcmpQueue failed on chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
          ),
        );

        if (xcmpMessage) {
          xcmpMessage.parachainId = chainId;
          xcmpMessage.parachainBlockHash = blockHash;
          xcmpMessage.xcmStatus = MESSAGE_STATUS.FAILED;

          await xcmpMessage.save();
        } else {
          const message = new MRLBridgeMessageQueueModel({
            accountId,
            messageHash,
            parachainId: chainId,
            parachainBlockHash: blockHash,
            xcmStatus: MESSAGE_STATUS.FAILED,
          });

          await message.save();
        }
      } else {
        const { moonbeamBlockHash, moonbeamExtrinsicHash, moonbeamTransactionHash, vaaBytes } = xcmpMessage || {};

        if (isMRLTransfer) {
          const transferSender = encodeAddress(
            (polkadotXcmSentEvent.event.data[0] as any)?.interior?.asX1?.asAccountId32?.id,
            addressPrefix,
          );

          if (moonbeamBlockHash && moonbeamTransactionHash && moonbeamExtrinsicHash && transferSender) {
            const parachainTxHash = generateMRLTransactionHash({
              messageHash,
              moonbeamBlockHash,
              moonbeamTransactionHash,
              moonbeamExtrinsicHash,
              parachainId: chainId,
              parachainExtrinsicHash,
              parachainBlockHash: blockHash,
            });

            console.log(
              `[CHAIN: ${chainId}, ID: ${
                accountId + "," + messageHash
              }] polkachain generate transfer transaction hash. ${JSON.stringify({
                chainId,
                messageHash,
                moonbeamBlockHash,
                moonbeamTransactionHash,
                moonbeamExtrinsicHash,
                parachainExtrinsicHash,
                parachainBlockHash: blockHash,
                transferSender,
              })}`,
            );

            await modifyExistedTransferRecordOrSaveToDB({
              chainId,
              accountId,
              messageHash,
              parachainTxHash,
              ethTxHash: moonbeamTransactionHash,
              transferSender,
              transferSourceChainId: chainId,
            });

            if (xcmpMessage) {
              xcmpMessage.parachainId = chainId;
              xcmpMessage.parachainExtrinsicHash = parachainExtrinsicHash;
              xcmpMessage.parachainBlockHash = blockHash;
              xcmpMessage.transferSender = transferSender;
              xcmpMessage.transferSourceChainId = chainId;

              await xcmpMessage.save();

              console.log(
                `[CHAIN: ${chainId}, ID: ${
                  accountId + "," + messageHash
                }] polkachain transfer xcmp message mark as done. messageHash: ${xcmpMessage.messageHash}, accountId: ${
                  xcmpMessage.accountId
                }, xcmStatus: ${xcmpMessage.xcmStatus}`,
              );
            }
          } else {
            const message = new MRLBridgeMessageQueueModel({
              accountId,
              messageHash,
              parachainId: chainId,
              parachainExtrinsicHash,
              parachainBlockHash: blockHash,
              transferSender,
              transferSourceChainId: chainId,
              xcmStatus: MESSAGE_STATUS.SUCCESS,
            });

            await message.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${
                accountId + "," + messageHash
              }] polkachain transfer xcmp message saved. ${JSON.stringify({
                accountId,
                messageHash,
                parachainId: chainId,
                parachainExtrinsicHash,
                parachainBlockHash: blockHash,
                transferSender,
                transferSourceChainId: chainId,
                xcmStatus: MESSAGE_STATUS.SUCCESS,
              })}`,
            );
          }
        } else if (isMRLRedemption) {
          if (moonbeamBlockHash && moonbeamExtrinsicHash && moonbeamTransactionHash && vaaBytes) {
            const parachainTxHash = generateMRLTransactionHash({
              messageHash,
              moonbeamBlockHash,
              moonbeamExtrinsicHash,
              moonbeamTransactionHash,
              parachainId: chainId,
              parachainExtrinsicHash,
              parachainBlockHash: blockHash,
            });

            console.log(
              `[CHAIN: ${chainId}, ID: ${
                accountId + "," + messageHash
              }] polkachain generate redemption transaction hash. ${JSON.stringify({
                chainId,
                messageHash,
                moonbeamBlockHash,
                moonbeamExtrinsicHash,
                moonbeamTransactionHash,
                parachainExtrinsicHash,
                parachainBlockHash: blockHash,
              })}`,
            );

            await modifyExistedRedemptionRecordOrSaveToDB({
              chainId,
              accountId,
              messageHash,
              parachainTxHash,
              vaaBytes,
            });

            if (xcmpMessage) {
              xcmpMessage.parachainId = chainId;
              xcmpMessage.parachainExtrinsicHash = parachainExtrinsicHash;
              xcmpMessage.parachainBlockHash = blockHash;
              xcmpMessage.xcmStatus =
                xcmpEvent?.event.method === "Fail" ? MESSAGE_STATUS.FAILED : MESSAGE_STATUS.SUCCESS;

              await xcmpMessage.save();

              console.log(
                `[CHAIN: ${chainId}, ID: ${
                  accountId + "," + messageHash
                }] polkachain redemption xcmp message mark as done. messageHash: ${
                  xcmpMessage.messageHash
                }, accountId: ${xcmpMessage.accountId}, xcmStatus: ${xcmpMessage.xcmStatus}`,
              );
            }
          } else {
            const message = new MRLBridgeMessageQueueModel({
              accountId,
              messageHash,
              parachainId: chainId,
              parachainBlockHash: blockHash,
              parachainExtrinsicHash,
              xcmStatus: MESSAGE_STATUS.SUCCESS,
            });

            await message.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${
                accountId + "," + messageHash
              }] polkachain redemption xcmp message saved. ${JSON.stringify({
                accountId,
                messageHash,
                parachainId: chainId,
                parachainBlockHash: blockHash,
                parachainExtrinsicHash,
                xcmStatus: MESSAGE_STATUS.SUCCESS,
              })}`,
            );
          }
        }
      }
    }
  } else if (isXCMTransfer || isXCMRedemption) {
    if (!blockHash) {
      console.error(new Error(`fail to find block hash on chainId: ${chainId}.`));
    } else if (!messageHash) {
      console.error(new Error(`empty messageHash on chainId: ${chainId}. blockHash: ${blockHash}`));
    } else if (!accountId) {
      console.error(
        new Error(`empty accountId on chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}`),
      );
    } else {
      console.log(
        `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] ${
          isXCMTransfer ? "XCM Transfer" : "XCM Redemption"
        } received. chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
      );

      const { extrinsicHash } = await getExtrinsicHashByBlockHashAndMessageHash({
        api,
        blockHash,
        messageHash,
        events,
      });

      const xcmBridgeMessage = await XCMBridgeMessageQueueModel.findOne(
        {
          type: isXCMTransfer ? XCM_BRIDGE_TYPE.Transfer : XCM_BRIDGE_TYPE.Redemption,
          messageHash,
        },
        null,
        { sort: { created: -1 } },
      );

      const xcmpEvents = sameExtrinsicEvents.filter((item) => {
        return item.event.section === "xcmpQueue";
      });
      const isXcmpFailed = xcmpEvents.some((item) => item.event.method === "Fail");
      // transfer has two xcmp events and redemption has one, and they all need to be successful
      const isSuccess = xcmpEvents.length === 1 && !isXcmpFailed && extrinsicHash;

      // if failed, save failed result and exist.
      if (!isSuccess) {
        console.error(
          new Error(
            `xcm bridge failed on chainId: ${chainId}. blockHash: ${blockHash}, messageHash: ${messageHash}, accountId: ${accountId}`,
          ),
        );

        if (xcmBridgeMessage) {
          xcmBridgeMessage.accountId = accountId;
          xcmBridgeMessage.messageHash = messageHash;
          xcmBridgeMessage.parachainId = chainId;
          xcmBridgeMessage.parachainBlockHash = blockHash;

          xcmBridgeMessage.xcmStatus = MESSAGE_STATUS.FAILED;

          await xcmBridgeMessage.save();
        } else {
          const message = new XCMBridgeMessageQueueModel({
            type: isXCMTransfer ? XCM_BRIDGE_TYPE.Transfer : XCM_BRIDGE_TYPE.Redemption,
            accountId: accountId,
            messageHash: messageHash,
            parachainId: chainId,
            parachainBlockHash: blockHash,
            xcmStatus: MESSAGE_STATUS.FAILED,
          });

          await message.save();
        }
      } else {
        if (isXCMTransfer) {
          if (xcmBridgeMessage) {
            xcmBridgeMessage.messageHash = messageHash;
            xcmBridgeMessage.parachainId = chainId;
            xcmBridgeMessage.accountId = accountId;
            xcmBridgeMessage.assetId = transferToken!.assetId;
            xcmBridgeMessage.parachainBlockHash = blockHash;
            xcmBridgeMessage.parachainExtrinsicHash = extrinsicHash;
            xcmBridgeMessage.amount = transferredMultiAssetsEventAmount;

            await xcmBridgeMessage.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] xcm transfer mark as done. messageHash: ${
                xcmBridgeMessage.messageHash
              }, accountId: ${xcmBridgeMessage.accountId}, xcmStatus: ${xcmBridgeMessage.xcmStatus}`,
            );

            const xcmRedemptionMessage = await XCMBridgeMessageQueueModel.findOne(
              {
                type: XCM_BRIDGE_TYPE.Redemption,
                messageHash: xcmBridgeMessage.relatedMessageHash,
              },
              null,
              { sort: { created: -1 } },
            );

            if (
              xcmRedemptionMessage &&
              xcmRedemptionMessage.messageHash &&
              xcmRedemptionMessage.accountId &&
              xcmRedemptionMessage.parachainId &&
              xcmRedemptionMessage.assetId &&
              xcmRedemptionMessage.parachainBlockHash &&
              xcmRedemptionMessage.parachainExtrinsicHash
            ) {
              const hashData = {
                sourceMessageHash: xcmBridgeMessage.messageHash,
                sourceAssetId: transferToken!.assetId,
                sourceParachainId: xcmBridgeMessage.parachainId,
                sourceParachainBlockHash: xcmBridgeMessage.parachainBlockHash,
                sourceParachainExtrinsicHash: xcmBridgeMessage.parachainExtrinsicHash,
                targetMessageHash: xcmRedemptionMessage.messageHash,
                targetAssetId: xcmRedemptionMessage.assetId,
                targetParachainId: xcmRedemptionMessage.parachainId,
                targetParachainBlockHash: xcmRedemptionMessage.parachainBlockHash,
                targetParachainExtrinsicHash: xcmRedemptionMessage.parachainExtrinsicHash,
              };
              const parachainTxHash = generateXCMTransactionHash(hashData);

              console.log(
                `[CHAIN: ${chainId}, ID: ${
                  accountId + "," + messageHash
                }] xcm transfer transaction hash generated. ${JSON.stringify(hashData)}`,
              );

              await createXCMBridgeRecord({
                chainId,
                messageHash,
                accountId,
                sourceChainId: chainId,
                sourceAssetId: transferToken!.assetId,
                sourceAccountId: accountId,
                targetChainId: xcmRedemptionMessage.parachainId,
                targetAssetId: xcmRedemptionMessage.assetId,
                targetAccountId: xcmRedemptionMessage.accountId,
                parachainTxHash,
                tokenAmt: transferredMultiAssetsEventAmount,
              });
            }
          } else {
            const messageData = {
              type: XCM_BRIDGE_TYPE.Transfer,
              messageHash,
              parachainId: chainId,
              accountId,
              assetId: transferToken!.assetId,
              parachainBlockHash: blockHash,
              parachainExtrinsicHash: extrinsicHash,
              amount: transferredMultiAssetsEventAmount,
              xcmStatus: MESSAGE_STATUS.SUCCESS,
            };
            const message = new XCMBridgeMessageQueueModel(messageData);

            await message.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] xcm transfer message saved. ${JSON.stringify(
                messageData,
              )}`,
            );
          }
        } else if (isXCMRedemption) {
          if (xcmBridgeMessage) {
            xcmBridgeMessage.messageHash = messageHash;
            xcmBridgeMessage.parachainId = chainId;
            xcmBridgeMessage.accountId = accountId;
            xcmBridgeMessage.assetId = redemptionToken!.assetId;
            xcmBridgeMessage.parachainBlockHash = blockHash;
            xcmBridgeMessage.parachainExtrinsicHash = extrinsicHash;

            await xcmBridgeMessage.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] xcm redemption mark as done. messageHash: ${
                xcmBridgeMessage.messageHash
              }, accountId: ${xcmBridgeMessage.accountId}, xcmStatus: ${xcmBridgeMessage.xcmStatus}`,
            );

            const xcmTransferMessage = await XCMBridgeMessageQueueModel.findOne(
              {
                type: XCM_BRIDGE_TYPE.Transfer,
                messageHash: xcmBridgeMessage.relatedMessageHash,
              },
              null,
              { sort: { created: -1 } },
            );

            if (
              xcmTransferMessage &&
              xcmTransferMessage.messageHash &&
              xcmTransferMessage.accountId &&
              xcmTransferMessage.parachainId &&
              xcmTransferMessage.assetId &&
              xcmTransferMessage.parachainBlockHash &&
              xcmTransferMessage.parachainExtrinsicHash
            ) {
              const hashData = {
                sourceMessageHash: xcmTransferMessage.messageHash,
                sourceAssetId: xcmTransferMessage.assetId,
                sourceParachainId: xcmTransferMessage.parachainId,
                sourceParachainBlockHash: xcmTransferMessage.parachainBlockHash,
                sourceParachainExtrinsicHash: xcmTransferMessage.parachainExtrinsicHash,
                targetMessageHash: xcmBridgeMessage.messageHash,
                targetAssetId: redemptionToken!.assetId,
                targetParachainId: xcmBridgeMessage.parachainId,
                targetParachainBlockHash: xcmBridgeMessage.parachainBlockHash,
                targetParachainExtrinsicHash: xcmBridgeMessage.parachainExtrinsicHash,
              };
              const parachainTxHash = generateXCMTransactionHash(hashData);

              console.log(
                `[CHAIN: ${chainId}, ID: ${
                  accountId + "," + messageHash
                }] xcm redemption transaction hash generated. ${JSON.stringify(hashData)}`,
              );

              await createXCMBridgeRecord({
                chainId,
                messageHash,
                accountId,
                sourceChainId: xcmTransferMessage.parachainId,
                sourceAssetId: xcmTransferMessage.assetId,
                sourceAccountId: xcmTransferMessage.accountId,
                targetChainId: chainId,
                targetAssetId: redemptionToken!.assetId,
                targetAccountId: accountId,
                parachainTxHash,
                tokenAmt: xcmTransferMessage.amount,
              });
            }
          } else {
            const messageData = {
              type: XCM_BRIDGE_TYPE.Redemption,
              messageHash,
              parachainId: chainId,
              accountId,
              assetId: redemptionToken!.assetId,
              parachainBlockHash: blockHash,
              parachainExtrinsicHash: extrinsicHash,
              xcmStatus: MESSAGE_STATUS.SUCCESS,
            };
            const message = new XCMBridgeMessageQueueModel(messageData);

            await message.save();

            console.log(
              `[CHAIN: ${chainId}, ID: ${accountId + "," + messageHash}] xcm redemption message saved. ${JSON.stringify(
                messageData,
              )}`,
            );
          }
        }
      }
    }
  }
}

export async function subscribePolkachainExtrinsicResult(options: { polkachainIds: Polkachain[] }) {
  const { polkachainIds } = options;

  console.log("subscribe on polkachain ids:", polkachainIds.join(","));

  try {
    const moonbeamApi = await getPolkadotProviderWithPolkaChainId(MOONBEAM_PARACHAIN_ID);

    const unsubMoonbeam = await moonbeamApi.query.system.events((events) => {
      setLatestMoonbeamSubscriptionResponseTime(Date.now());

      try {
        handleMoonbeamMessage({
          api: moonbeamApi,
          events,
        });
      } catch (e) {
        console.error(e);
      }
    });

    for (let polkachainId of polkachainIds) {
      const polkachainApi = await getPolkadotProviderWithPolkaChainId(polkachainId);
      const addressPrefix = await getParachainAddressPrefix(polkachainApi);

      const unsubPolkachain = await polkachainApi.query.system.events((events) => {
        setLatestParachaianSubscriptionResponseTime(polkachainId, Date.now());

        try {
          handlePolkachainMessage({ chainId: polkachainId, api: polkachainApi, events, addressPrefix });
        } catch (e) {
          console.error(e);
        }
      });
    }
  } catch (e) {
    console.error("error happens on polkachain extrinsic subscriber. ", e);
  }
}

function getParachainTokenByLocation(location: any, chainId: Polkachain) {
  const avaiableTokens = PolkachainTokens[chainId];
  const accountKey20 = location?.interior?.x3[2]?.accountKey20?.key?.toLowerCase();

  return avaiableTokens.find((item) => {
    const tokenLocation = isPolkadotXCMV3(chainId) ? item.location.V3 : item.location.V1;
    const tokenAccountKey20 = tokenLocation.interior.X3[2].AccountKey20.key.toLowerCase();

    return tokenAccountKey20 === accountKey20;
  });
}

function getParachainTokenByAssetIds(assetIds: string[], chainId: Polkachain) {
  const avaiableTokens = PolkachainTokens[chainId];

  return avaiableTokens.find((item) =>
    assetIds.includes(chainId === Polkachain.PeaqAgung ? item.parachainSymbol || item.symbol : item.assetId),
  );
}

function checkGLMRExistsOnAssetIds(assetIds: string[], chainId: Polkachain) {
  const xcGLMR = PolkachainXcGLMR[chainId];

  return assetIds.includes(chainId === Polkachain.PeaqAgung ? xcGLMR.symbol : xcGLMR.assetId);
}
