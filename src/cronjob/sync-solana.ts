import {
  CompiledInstruction,
  Connection,
  MessageCompiledInstruction,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  TransactionResponse,
} from "@solana/web3.js";
import base58 from "bs58";
import {
  MOONBEAM_MRL_PRECOMPILE_ADDRESS,
  getBridgeChains,
  getEVMProviderWithWormholeChain,
  getTBTCAddressForChain,
  getTBTCGatewayForChain,
  getWtBTCAddressForChain,
} from "../bridge";
import { ITxn, TransactionModel } from "../database/txnModel";
import { TXN_STATUS, TXN_TYPE } from "../utils/constants";
import { BigNumber, ethers } from "ethers";
import {
  ChainId as WormholeChainId,
  CHAIN_ID_SOLANA,
  getSignedVAAHash,
  isEVMChain,
  parseNftTransferPayload,
  parseTokenTransferPayload,
  CHAIN_ID_MOONBEAM,
  tryUint8ArrayToNative,
  CHAIN_ID_ETH,
  deriveNftEndpointKey,
  NftWrappedMeta,
  deriveEndpointKey as deriveTokenEndpointKey,
  deriveWrappedMetaKey,
  WrappedMeta as TokenWrappedMeta,
  deriveWormholeEmitterKey,
  PostedVaaData,
  getAccountData,
} from "../utils/wormhole";

import {
  fetchForeignAsset,
  fetchVaaFromWormholeRpcHosts,
  getERC20Info,
  getERC721Info,
  SignedVaaResult,
} from "../utils/utils";
import { ChainId, Client, UtlConfig } from "../utils/sol-metadata";
import { IToken, TokenModel } from "../database/tokenModel";
import { BasicTokenIdentity, ExtendedTokenIdentity } from "../utils/interfaces";
import dayjs from "dayjs";
import { parsePolkachainTxPayload } from "../utils/polkadot";
import { BorshCoder, Instruction as AnchorInstruction } from "@coral-xyz/anchor";
import { WormholeGatewayIdl } from "../utils/sol-idls/tbtc-wormhole-gateway";
import { InstructionDisplay } from "@coral-xyz/anchor/dist/cjs/coder/borsh/instruction";
import { constructSolanaConnection } from "../utils/solana";
import { addTokensToDB, addTransactionsToDB } from "../database/helper";
import { cctpSDK, getCCTPNetworkConfigs, getChainIdByDomain, hashSourceChainAndNonce } from "../utils/cctp";
import { CCTPDomain, decodeMessage } from "@automata-network/cctp-sdk";
import { CCTPTokenMessengerMinterIdl } from "../utils/sol-idls/token-messenger-minter";
import { CCTPMessageTransmitterIdl } from "../utils/sol-idls/message-transmitter";
import { Document } from "mongoose";
import * as borsh from "@coral-xyz/borsh";

let latestTokenBridgeTransactionSignature: string | undefined;
let latestNftBridgeTransactionSignature: string | undefined;
let latestTBTCTransactionSignature: string | undefined;
let latestUSDCTransactionSignature: string | undefined;

enum TokenBridgeInstruction {
  Initialize,
  AttestToken,
  CompleteNative,
  CompleteWrapped,
  TransferWrapped,
  TransferNative,
  RegisterChain,
  CreateWrapped,
  UpgradeContract,
  CompleteNativeWithPayload,
  CompleteWrappedWithPayload,
  TransferWrappedWithPayload,
  TransferNativeWithPayload,
}

enum NftBridgeInstruction {
  Initialize,
  CompleteNative,
  CompleteWrapped,
  CompleteWrappedMeta,
  TransferWrapped,
  TransferNative,
  RegisterChain,
  UpgradeContract,
}

interface Instruction {
  name: TokenBridgeInstruction | NftBridgeInstruction;
  accounts: PublicKey[];
  instruction: ParsedInstruction | PartiallyDecodedInstruction;
}

interface Transaction {
  programPubKey: PublicKey;
  instruction?: Instruction;
  signature: string;
  transactionResponse: ParsedTransactionWithMeta | null;
}

const chains = getBridgeChains();
const { chainId, wormholeTokenBridge, wormholeNFTBridge } = chains.SOLANA;
const tokenBridgePublicKey = new PublicKey(wormholeTokenBridge);
const nftBridgePublicKey = new PublicKey(wormholeNFTBridge);
const transactionLimit = 50;
const SOLANA_SEQ_LOG = "Program log: Sequence: ";

export async function syncUSDCNewTransactions() {
  const connection = constructSolanaConnection("confirmed");

  const latestTxn = await getLatestUSDCTransactionHash();

  if (!latestTxn) {
    console.error("latestUSDCTransactionSignature is empty");

    return;
  } else {
    console.log("latestUSDCTransactionSignature: ", latestTxn);
  }

  const transaction = await fetchUSDCValidTransactions({
    connection,
    untilSignature: latestUSDCTransactionSignature,
  });

  if (transaction.validTransactions.length) {
    console.log(
      "solana usdc new transactions: ",
      transaction.validTransactions.map((item) => `[USDC] ${item.transactionSignature}`).join(","),
    );

    await indexUSDCTransactions(connection, transaction.validTransactions);
  }

  if (transaction.allTransactionSignatures.length !== 0) {
    latestTokenBridgeTransactionSignature = transaction.allTransactionSignatures[0];
  }
}

export async function syncTBTCNewTransactions() {
  const connection = constructSolanaConnection("confirmed");

  const latestTxn = await getLatestTBTCTransactionHash();

  if (!latestTxn) {
    console.error("latestTBTCTransactionSignature is empty");

    return;
  } else {
    console.log("latestTBTCTransactionSignature: ", latestTxn);
  }

  const transaction = await fetchTbtcValidTransactions({
    connection,
    untilSignature: latestTBTCTransactionSignature,
  });

  if (transaction.validTransactions.length) {
    console.log(
      "solana token bridge new transactions: ",
      transaction.validTransactions.map((item) => `[TBTC] ${item.transactionSignature}`).join(","),
    );

    await indexTBTCTransactions(connection, transaction.validTransactions);
  }

  if (transaction.allTransactionSignatures.length !== 0) {
    latestTokenBridgeTransactionSignature = transaction.allTransactionSignatures[0];
  }
}

export async function syncTokenBridgeNewTransactions() {
  const connection = constructSolanaConnection("confirmed");

  const latestTxn = await getLatestTokenBridgeTransactionHash();

  if (!latestTxn) {
    console.error("latestTokenBridgeTransactionSignature is empty");

    return;
  } else {
    console.log("latestTokenBridgeTransactionSignature: ", latestTxn);
  }

  const transaction = await fetchProgramValidTransactions({
    connection,
    programPubkey: tokenBridgePublicKey,
    untilSignature: latestTxn,
    validInstructions: [
      TokenBridgeInstruction.TransferNative,
      TokenBridgeInstruction.TransferWrapped,
      TokenBridgeInstruction.TransferNativeWithPayload,
      TokenBridgeInstruction.TransferWrappedWithPayload,
      TokenBridgeInstruction.CompleteNative,
      TokenBridgeInstruction.CompleteWrapped,
      TokenBridgeInstruction.CompleteNativeWithPayload,
      TokenBridgeInstruction.CompleteWrappedWithPayload,
    ],
  });

  if (transaction.validTransactions.length) {
    console.log(
      "solana token bridge new transactions: ",
      transaction.validTransactions
        .map((item) => `[${TokenBridgeInstruction[item.instruction!.name]}] ${item.signature}`)
        .join(","),
    );

    await indexTransactions(connection, transaction.validTransactions);
  }

  if (transaction.allTransactionSignatures.length !== 0) {
    latestTokenBridgeTransactionSignature = transaction.allTransactionSignatures[0];
  }
}

export async function syncNftBridgeNewTransactions() {
  const connection = constructSolanaConnection("confirmed");

  if (!latestNftBridgeTransactionSignature) {
    const now = dayjs().unix();
    const solanaNftBridgeEarliestTxHashEffectiveBefore =
      process.env.SOLANA_NFT_BRIDGE_EARLIEST_TX_HASH_EFFECTIVE_BEFORE;
    const isSolanaNftBridgeEarliestTxHashEffective = solanaNftBridgeEarliestTxHashEffectiveBefore
      ? now < parseInt(solanaNftBridgeEarliestTxHashEffectiveBefore)
      : false;

    console.log("timestamp", now);
    console.log("solanaNftBridgeEarliestTxHashEffectiveBefore", solanaNftBridgeEarliestTxHashEffectiveBefore);
    console.log("isSolanaNftBridgeEarliestTxHashEffective", isSolanaNftBridgeEarliestTxHashEffective);
    console.log("SOLANA_NFT_BRIDGE_EARLIEST_TX_HASH", process.env.SOLANA_NFT_BRIDGE_EARLIEST_TX_HASH);

    if (isSolanaNftBridgeEarliestTxHashEffective && process.env.SOLANA_NFT_BRIDGE_EARLIEST_TX_HASH) {
      latestNftBridgeTransactionSignature = process.env.SOLANA_NFT_BRIDGE_EARLIEST_TX_HASH;
    } else {
      // fetch the last indexed transaction from indexer
      const lastTxn = await getLastestIndexedTransaction(TXN_TYPE.NFT_BRIDGE);

      if (lastTxn) {
        latestNftBridgeTransactionSignature = lastTxn.txn;
      }
    }
  }

  if (!latestNftBridgeTransactionSignature) {
    console.error("latestNftBridgeTransactionSignature is empty");

    return;
  } else {
    console.log("latestNftBridgeTransactionSignature: ", latestNftBridgeTransactionSignature);
  }

  const transaction = await fetchProgramValidTransactions({
    connection,
    programPubkey: nftBridgePublicKey,
    untilSignature: latestNftBridgeTransactionSignature,
    validInstructions: [
      NftBridgeInstruction.TransferNative,
      NftBridgeInstruction.TransferWrapped,
      NftBridgeInstruction.CompleteNative,
      NftBridgeInstruction.CompleteWrapped,
    ],
  });

  if (transaction.validTransactions.length) {
    console.log(
      "solana nft bridge new transactions: ",
      transaction.validTransactions
        .map((item) => `[${NftBridgeInstruction[item.instruction!.name]}] ${item.signature}`)
        .join(","),
    );

    await indexTransactions(connection, transaction.validTransactions);
  }

  if (transaction.allTransactionSignatures.length !== 0) {
    latestNftBridgeTransactionSignature = transaction.allTransactionSignatures[0];
  }
}

async function fetchProgramValidTransactions(options: {
  connection: Connection;
  programPubkey: PublicKey;
  untilSignature?: string;
  beforeSignature?: string;
  validInstructions: (TokenBridgeInstruction | NftBridgeInstruction)[];
}) {
  const { connection, programPubkey, untilSignature, beforeSignature, validInstructions } = options;

  const transactions = await connection.getSignaturesForAddress(programPubkey, {
    until: !!untilSignature ? untilSignature : undefined,
    before: !!beforeSignature ? beforeSignature : undefined,
    limit: transactionLimit,
  });

  console.log("fetchProgramValidTransactions: ", transactions.map((item) => item.signature).join(","));

  const records = await TransactionModel.find({ txn: { $in: transactions.map((item) => item.signature) } });
  const existedSignatures = records.map((item) => item.txn);
  const notExistedTransactions = transactions.filter(
    (transaction) => !existedSignatures.includes(transaction.signature),
  );

  const transactionSignatures = notExistedTransactions.map((item) => item.signature);

  let transactionResponses: ParsedTransactionWithMeta[] = [];

  for (const sig of transactionSignatures) {
    // some solana node rpc does not support batch calls e.g. getParsedTransactions
    let transactionResp = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (transactionResp) {
      transactionResponses.push(transactionResp);
    }
  }

  const validTransactions = filterTransactions(
    programPubkey,
    transactionSignatures,
    transactionResponses.map((item, index) => {
      return { programPubkey, signature: transactionSignatures[index], resp: item };
    }),
    validInstructions,
  );

  console.log(`fetchProgramValidTransactions transactionResponses: ${transactionResponses.length}`);

  return {
    allTransactionSignatures: transactionSignatures,
    validTransactions,
  };
}

async function fetchAllProgramValidTransactionsRecursively(options: {
  prevAllTransactionSignatures?: string[];
  prevValidTransactions?: Transaction[];
  connection: Connection;
  programPubkey: PublicKey;
  untilSignature?: string;
  beforeSignature?: string;
  validInstructions: (TokenBridgeInstruction | NftBridgeInstruction)[];
}): Promise<{ allTransactionSignatures: string[]; validTransactions: Transaction[] }> {
  const {
    prevAllTransactionSignatures,
    prevValidTransactions,
    connection,
    programPubkey,
    untilSignature,
    beforeSignature,
    validInstructions,
  } = options;

  const partialTransactions = await fetchProgramValidTransactions({
    connection,
    programPubkey,
    untilSignature,
    beforeSignature,
    validInstructions,
  });

  if (partialTransactions.allTransactionSignatures.length === 0) {
    return {
      allTransactionSignatures: prevAllTransactionSignatures || [],
      validTransactions: prevValidTransactions || [],
    };
  } else {
    return fetchAllProgramValidTransactionsRecursively({
      prevAllTransactionSignatures: prevAllTransactionSignatures
        ? [...prevAllTransactionSignatures, ...partialTransactions.allTransactionSignatures]
        : partialTransactions.allTransactionSignatures,
      prevValidTransactions: prevValidTransactions
        ? [...prevValidTransactions, ...partialTransactions.validTransactions]
        : partialTransactions.validTransactions,
      connection,
      programPubkey,
      untilSignature,
      beforeSignature:
        partialTransactions.allTransactionSignatures[partialTransactions.allTransactionSignatures.length - 1],
      validInstructions,
    });
  }
}

interface ParsedTransactionResp {
  programPubkey: PublicKey;
  signature: string;
  resp: ParsedTransactionWithMeta | null;
}

function filterTransactions(
  programPubKey: PublicKey,
  transactionSignatures: string[],
  transactions: ParsedTransactionResp[],
  validInstructions: (TokenBridgeInstruction | NftBridgeInstruction)[],
): Transaction[] {
  return transactions
    .map((transaction, index) => {
      if (transaction.resp) {
        const instruction = transaction.resp.transaction.message.instructions.find(
          (item) => item.programId.toString() === programPubKey.toString(),
        );

        if (instruction && "data" in instruction && "accounts" in instruction) {
          const decodedData = base58.decode(instruction.data);
          // according to https://github.com/wormhole-foundation/wormhole/blob/main/sdk/js/src/solana/nftBridge/coder/instruction.ts#L59
          // first 1 byte is the unit8 instructionName
          const instructionName = Buffer.from(decodedData).subarray(0, 1).readUInt8();

          return {
            signature: transactionSignatures[index],
            programPubKey,
            instruction: { name: instructionName, accounts: instruction.accounts, instruction },
            transactionResponse: transaction.resp,
          };
        }
      }
    })
    .filter((item) => {
      return item && item.instruction && validInstructions.includes(item.instruction.name);
    }) as Transaction[];
}

function parseSequenceFromLogSolana(logs?: string[]) {
  // TODO: better parsing, safer
  const sequence = logs?.filter((msg) => msg.startsWith(SOLANA_SEQ_LOG))?.[0]?.replace(SOLANA_SEQ_LOG, "");

  return sequence ? sequence.toString() : undefined;
}

interface VaaAccountKey {
  signature: string;
  vaaAccountKey: PublicKey;
}

function getVaaAccountKey(transaction: Transaction): VaaAccountKey | undefined {
  const { programPubKey, instruction, signature } = transaction;

  // account info might be null
  if (instruction && instruction.accounts.length > 0) {
    if (programPubKey === tokenBridgePublicKey) {
      if (
        instruction.name === TokenBridgeInstruction.CompleteNative ||
        instruction.name === TokenBridgeInstruction.CompleteNativeWithPayload ||
        instruction.name === TokenBridgeInstruction.CompleteWrapped ||
        instruction.name === TokenBridgeInstruction.CompleteWrappedWithPayload
      ) {
        return {
          signature,
          vaaAccountKey: instruction.accounts[2],
        };
      }
    } else if (programPubKey === nftBridgePublicKey) {
      if (
        instruction.name === NftBridgeInstruction.CompleteNative ||
        instruction.name === NftBridgeInstruction.CompleteWrapped
      ) {
        return {
          signature,
          vaaAccountKey: instruction.accounts[2],
        };
      }
    }
  }
}

function getMetaKey(programId: PublicKey, transaction: Transaction): PublicKey | undefined {
  const { programPubKey, instruction } = transaction;

  if (instruction) {
    if (programPubKey === tokenBridgePublicKey) {
      if (
        instruction.name === TokenBridgeInstruction.TransferWrapped ||
        instruction.name === TokenBridgeInstruction.TransferWrappedWithPayload
      ) {
        const mintKey = instruction.accounts[4];
        return deriveWrappedMetaKey(programId, mintKey);
      } else if (
        instruction.name === TokenBridgeInstruction.CompleteWrapped ||
        instruction.name === TokenBridgeInstruction.CompleteWrappedWithPayload
      ) {
        const mintKey = instruction.accounts[7];
        return deriveWrappedMetaKey(programId, mintKey);
      }
    } else if (programPubKey === nftBridgePublicKey) {
      if (instruction.name === NftBridgeInstruction.TransferWrapped) {
        const mintKey = instruction.accounts[4];
        return deriveWrappedMetaKey(programId, mintKey);
      } else if (instruction.name === NftBridgeInstruction.CompleteWrapped) {
        const mintKey = instruction.accounts[7];
        return deriveWrappedMetaKey(programId, mintKey);
      }
    }
  }
}

async function constructTransactionModal(options: {
  transaction: Transaction;
  postedVaa?: PostedVaaData;
  wrappedMeta?: NftWrappedMeta | TokenWrappedMeta | undefined;
  signedVaaBytes?: string;
}): Promise<ITxn | undefined> {
  const { transaction, postedVaa, wrappedMeta, signedVaaBytes } = options;
  const { programPubKey, instruction, signature, transactionResponse } = transaction;

  if (instruction) {
    if (programPubKey === tokenBridgePublicKey) {
      if (
        (instruction.name === TokenBridgeInstruction.TransferNative ||
          instruction.name === TokenBridgeInstruction.TransferNativeWithPayload) &&
        "data" in instruction.instruction
      ) {
        const tokenTransferPayload = (
          instruction.name === TokenBridgeInstruction.TransferNative
            ? parseTokenBridgeTransferNativeData
            : parseTokenBridgeTransferNativeWithPayloadData
        )(instruction.instruction.data);
        const { nonce, amount, fee, targetAddress, targetChain } = tokenTransferPayload;
        const sequence =
          transactionResponse && transactionResponse.meta && transactionResponse.meta.logMessages
            ? parseSequenceFromLogSolana(transactionResponse.meta.logMessages)
            : undefined;
        const isMRLTransfer: boolean =
          targetChain === CHAIN_ID_MOONBEAM &&
          targetAddress.toLowerCase() ===
            ethers.utils.hexlify(ethers.utils.stripZeros(MOONBEAM_MRL_PRECOMPILE_ADDRESS)).toLowerCase();
        const mrlPayload =
          isMRLTransfer && "payload" in tokenTransferPayload
            ? await parsePolkachainTxPayload(tokenTransferPayload.payload)
            : undefined;
        const recipient = mrlPayload?.accountId || targetAddress;
        const sourceTokenAddress = instruction.accounts[3].toString();
        const sourceChainId = chainId;
        const destChainId = mrlPayload?.parachainId || targetChain;
        const destTokenAddress = await computeForeignAsset(
          sourceTokenAddress,
          sourceChainId,
          destChainId as WormholeChainId,
        );

        const txn: ITxn | undefined = sequence
          ? {
              txnType: TXN_TYPE.TOKEN_BRIDGE,
              txn: signature,
              sender: instruction.accounts[0].toString(),
              recipient,
              arbiterFee: fee ? fee.toString() : "0",
              isSourceNative: true,
              sourceTokenAddress, // native token address
              sourceChainId, // native token chain
              destChainId,
              destTokenAddress,
              emitterAddress: deriveWormholeEmitterKey(tokenBridgePublicKey).toBuffer().toString("hex"),
              wormholeSequence: sequence,
              tokenAmt: amount.toString(),
              status: TXN_STATUS.PENDING,
              updated: new Date(),
              created: new Date(),
            }
          : undefined;

        return txn;
      } else if (
        (instruction.name === TokenBridgeInstruction.TransferWrapped ||
          instruction.name === TokenBridgeInstruction.TransferWrappedWithPayload) &&
        "data" in instruction.instruction
      ) {
        const tokenTransferPayload = (
          instruction.name === TokenBridgeInstruction.TransferWrapped
            ? parseTokenBridgeTransferNativeData
            : parseTokenBridgeTransferNativeWithPayloadData
        )(instruction.instruction.data);
        const { nonce, amount, fee, targetAddress, targetChain } = tokenTransferPayload;
        const sequence =
          transactionResponse && transactionResponse.meta && transactionResponse.meta.logMessages
            ? parseSequenceFromLogSolana(transactionResponse.meta.logMessages)
            : undefined;
        const isMRLTransfer: boolean =
          targetChain === CHAIN_ID_MOONBEAM &&
          targetAddress.toLowerCase() ===
            ethers.utils.hexlify(ethers.utils.stripZeros(MOONBEAM_MRL_PRECOMPILE_ADDRESS)).toLowerCase();
        const mrlPayload =
          isMRLTransfer && "payload" in tokenTransferPayload
            ? await parsePolkachainTxPayload(tokenTransferPayload.payload)
            : undefined;

        const recipient = mrlPayload?.accountId || targetAddress;
        const destChainId = mrlPayload?.parachainId || targetChain;
        const unwrappedSourceTokenAddress = wrappedMeta ? parseAddress(wrappedMeta.tokenAddress) : undefined; // unwrapped source token address
        const unwrappedSourceChainId = wrappedMeta?.chain; // unwrapped source chain
        const destTokenAddress =
          unwrappedSourceTokenAddress && unwrappedSourceChainId
            ? await computeForeignAsset(
                unwrappedSourceTokenAddress,
                unwrappedSourceChainId as WormholeChainId,
                destChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          sequence && wrappedMeta && destTokenAddress
            ? {
                txnType: TXN_TYPE.TOKEN_BRIDGE,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient,
                arbiterFee: fee ? fee.toString() : "0",
                isSourceNative: false,
                sourceTokenAddress: instruction.accounts[4].toString(), // wrapped token address
                sourceChainId: chainId, // wrapped token chain
                unwrappedSourceTokenAddress, // unwrapped source token address
                unwrappedSourceChainId, // unwrapped source chain
                destChainId,
                destTokenAddress,
                emitterAddress: deriveWormholeEmitterKey(tokenBridgePublicKey).toBuffer().toString("hex"),
                wormholeSequence: sequence,
                tokenAmt: amount.toString(),
                status: TXN_STATUS.PENDING,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      } else if (
        instruction.name === TokenBridgeInstruction.CompleteNative ||
        instruction.name === TokenBridgeInstruction.CompleteNativeWithPayload
      ) {
        const payload = postedVaa ? parseTokenTransferPayload(postedVaa.message.payload) : undefined;
        const tokenBridgeRegisteredEmitter = postedVaa
          ? deriveTokenEndpointKey(
              tokenBridgePublicKey,
              postedVaa.message.emitterChain,
              postedVaa.message.emitterAddress,
            )
          : undefined;
        const sourceChainId = postedVaa?.message.emitterChain;
        const sourceTokenAddress =
          sourceChainId && payload
            ? await computeForeignAsset(
                tryUint8ArrayToNative(payload.tokenAddress, payload.tokenChain as WormholeChainId),
                payload.tokenChain as WormholeChainId,
                sourceChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          postedVaa && payload && signedVaaBytes && tokenBridgeRegisteredEmitter && sourceTokenAddress && sourceChainId
            ? {
                txnType: TXN_TYPE.REDEEM,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient: instruction.accounts[5].toString(), // associated token account
                isSourceNative: true,
                unwrappedSourceTokenAddress: parsePayloadAddress(payload.tokenAddress), // source token address
                unwrappedSourceChainId: payload.tokenChain, // source token chain
                sourceTokenAddress,
                sourceChainId,
                destTokenAddress: instruction.accounts[8].toString(), // native token address
                destChainId: chainId, // native token chain
                emitterAddress: tokenBridgeRegisteredEmitter.toString(),
                wormholeSequence: postedVaa.message.sequence.toString(),
                tokenAmt: payload.amount.toString(),
                signedVAABytes: signedVaaBytes,
                signedVAAHash: getSignedVAAHash(Buffer.from(signedVaaBytes, "base64")),
                status: TXN_STATUS.CONFIRMED,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      } else if (
        instruction.name === TokenBridgeInstruction.CompleteWrapped ||
        instruction.name === TokenBridgeInstruction.CompleteWrappedWithPayload
      ) {
        const payload = postedVaa ? parseTokenTransferPayload(postedVaa.message.payload) : undefined;
        const tokenBridgeRegisteredEmitter = postedVaa
          ? deriveTokenEndpointKey(
              tokenBridgePublicKey,
              postedVaa.message.emitterChain,
              postedVaa.message.emitterAddress,
            )
          : undefined;
        const sourceChainId = postedVaa?.message.emitterChain;
        const sourceTokenAddress =
          sourceChainId && payload
            ? await computeForeignAsset(
                tryUint8ArrayToNative(payload.tokenAddress, payload.tokenChain as WormholeChainId),
                payload.tokenChain as WormholeChainId,
                sourceChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          postedVaa &&
          payload &&
          wrappedMeta &&
          signedVaaBytes &&
          tokenBridgeRegisteredEmitter &&
          sourceTokenAddress &&
          sourceChainId
            ? {
                txnType: TXN_TYPE.REDEEM,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient: instruction.accounts[5].toString(), // associated token account
                isSourceNative: false,
                unwrappedSourceTokenAddress: parseAddress(wrappedMeta.tokenAddress), // unwrapped token address
                unwrappedSourceChainId: wrappedMeta.chain, // unwrapped token chain
                sourceChainId,
                sourceTokenAddress,
                destTokenAddress: instruction.accounts[7].toString(), // wrapped token account
                destChainId: chainId,
                emitterAddress: tokenBridgeRegisteredEmitter.toString(),
                wormholeSequence: postedVaa.message.sequence.toString(),
                tokenAmt: payload.amount.toString(),
                signedVAABytes: signedVaaBytes,
                signedVAAHash: getSignedVAAHash(Buffer.from(signedVaaBytes, "base64")),
                status: TXN_STATUS.CONFIRMED,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      }
    } else if (programPubKey === nftBridgePublicKey) {
      if (instruction.name === NftBridgeInstruction.TransferNative && "data" in instruction.instruction) {
        const { nonce, targetAddress, targetChain } = parseNftBridgeTransferNativeData(instruction.instruction.data);
        const sequence =
          transactionResponse && transactionResponse.meta && transactionResponse.meta.logMessages
            ? parseSequenceFromLogSolana(transactionResponse.meta.logMessages)
            : undefined;
        const sourceTokenAddress = instruction.accounts[3].toString();
        const sourceChainId = chainId;
        const destChainId = targetChain;
        const destTokenAddress = await computeForeignAsset(
          sourceTokenAddress,
          sourceChainId,
          destChainId as WormholeChainId,
        );

        const txn: ITxn | undefined = sequence
          ? {
              txnType: TXN_TYPE.NFT_BRIDGE,
              txn: signature,
              sender: instruction.accounts[0].toString(),
              recipient: targetAddress,
              isSourceNative: true,
              sourceTokenAddress, // solana NFT address
              sourceChainId, // solana NFT chain
              destChainId,
              destTokenAddress,
              emitterAddress: deriveWormholeEmitterKey(nftBridgePublicKey).toBuffer().toString("hex"),
              wormholeSequence: sequence,
              tokenAmt: "1",
              status: TXN_STATUS.PENDING,
              updated: new Date(),
              created: new Date(),
            }
          : undefined;

        return txn;
      } else if (instruction.name === NftBridgeInstruction.TransferWrapped && "data" in instruction.instruction) {
        const { nonce, targetAddress, targetChain } = parseNftBridgeTransferNativeData(instruction.instruction.data);
        const sequence =
          transactionResponse && transactionResponse.meta && transactionResponse.meta.logMessages
            ? parseSequenceFromLogSolana(transactionResponse.meta.logMessages)
            : undefined;
        const tokenId = wrappedMeta && "tokenId" in wrappedMeta ? wrappedMeta.tokenId : undefined;
        const unwrappedSourceTokenAddress = wrappedMeta ? parseAddress(wrappedMeta.tokenAddress) : undefined; // unwrapped source token address
        const unwrappedSourceChainId = wrappedMeta?.chain; // unwrapped source chain
        const destChainId = targetChain;
        const destTokenAddress =
          unwrappedSourceTokenAddress && unwrappedSourceChainId
            ? await computeForeignAsset(
                unwrappedSourceTokenAddress,
                unwrappedSourceChainId as WormholeChainId,
                destChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          sequence && tokenId && wrappedMeta && destTokenAddress
            ? {
                txnType: TXN_TYPE.NFT_BRIDGE,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient: targetAddress,
                tokenId: tokenId.toString(),
                isSourceNative: false,
                sourceTokenAddress: instruction.accounts[4].toString(), // wrapped NFT address
                sourceChainId: chainId, // wrapped NFT chain
                unwrappedSourceTokenAddress, // unwrapped NFT address
                unwrappedSourceChainId, // unwrapped NFT chain
                destChainId,
                destTokenAddress,
                emitterAddress: deriveWormholeEmitterKey(nftBridgePublicKey).toBuffer().toString("hex"),
                wormholeSequence: sequence,
                tokenAmt: "1",
                status: TXN_STATUS.PENDING,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      } else if (instruction.name === NftBridgeInstruction.CompleteNative) {
        const payload = postedVaa ? parseNftTransferPayload(postedVaa.message.payload) : undefined;
        const nftRegisteredEmitter = postedVaa
          ? deriveNftEndpointKey(nftBridgePublicKey, postedVaa.message.emitterChain, postedVaa.message.emitterAddress)
          : undefined;
        const sourceChainId = postedVaa?.message.emitterChain;
        const sourceTokenAddress =
          sourceChainId && payload
            ? await computeForeignAsset(
                tryUint8ArrayToNative(payload.tokenAddress, payload.tokenChain as WormholeChainId),
                payload.tokenChain as WormholeChainId,
                sourceChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          payload && postedVaa && signedVaaBytes && nftRegisteredEmitter && sourceChainId && sourceTokenAddress
            ? {
                txnType: TXN_TYPE.REDEEM,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient: instruction.accounts[5].toString(), // associated token account
                isSourceNative: true,
                unwrappedSourceTokenAddress: parsePayloadAddress(payload.tokenAddress), // source token address
                unwrappedSourceChainId: payload.tokenChain, // source token chain
                sourceChainId,
                sourceTokenAddress,
                destTokenAddress: instruction.accounts[8].toString(),
                destChainId: chainId,
                emitterAddress: nftRegisteredEmitter.toString(),
                wormholeSequence: postedVaa.message.sequence.toString(),
                tokenAmt: "1",
                signedVAABytes: signedVaaBytes,
                signedVAAHash: getSignedVAAHash(Buffer.from(signedVaaBytes, "base64")),
                status: TXN_STATUS.CONFIRMED,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      } else if (instruction.name === NftBridgeInstruction.CompleteWrapped) {
        const payload = postedVaa ? parseNftTransferPayload(postedVaa.message.payload) : undefined;
        const tokenId = wrappedMeta && "tokenId" in wrappedMeta ? wrappedMeta.tokenId : undefined;
        const nftRegisteredEmitter = postedVaa
          ? deriveNftEndpointKey(nftBridgePublicKey, postedVaa.message.emitterChain, postedVaa.message.emitterAddress)
          : undefined;
        const sourceChainId = postedVaa?.message.emitterChain;
        const sourceTokenAddress =
          sourceChainId && payload
            ? await computeForeignAsset(
                tryUint8ArrayToNative(payload.tokenAddress, payload.tokenChain as WormholeChainId),
                payload.tokenChain as WormholeChainId,
                sourceChainId as WormholeChainId,
              )
            : undefined;

        const txn: ITxn | undefined =
          postedVaa &&
          payload &&
          wrappedMeta &&
          signedVaaBytes &&
          tokenId &&
          nftRegisteredEmitter &&
          sourceChainId &&
          sourceTokenAddress
            ? {
                txnType: TXN_TYPE.REDEEM,
                txn: signature,
                sender: instruction.accounts[0].toString(),
                recipient: instruction.accounts[5].toString(), // associated token account
                tokenId: tokenId.toString(),
                isSourceNative: false,
                unwrappedSourceTokenAddress: parseAddress(wrappedMeta.tokenAddress), // unwrapped NFT address
                unwrappedSourceChainId: wrappedMeta.chain, // unwrapped NFT chain
                sourceChainId,
                sourceTokenAddress,
                destTokenAddress: instruction.accounts[7].toString(),
                destChainId: chainId,
                emitterAddress: nftRegisteredEmitter.toString(),
                wormholeSequence: postedVaa.message.sequence.toString(),
                tokenAmt: "1",
                signedVAABytes: signedVaaBytes,
                signedVAAHash: getSignedVAAHash(Buffer.from(signedVaaBytes, "base64")),
                status: TXN_STATUS.CONFIRMED,
                updated: new Date(),
                created: new Date(),
              }
            : undefined;

        return txn;
      }
    }
  }
}

async function getSignedVaasFromPostedVaas(postedVaas: PostedVaaData[]): Promise<(SignedVaaResult | undefined)[]> {
  const vaaSequenceDatas = postedVaas.map((item) => {
    return {
      emitterChain: item.message.emitterChain,
      emitterAddress: item.message.emitterAddress,
      sequence: item.message.sequence,
    };
  });
  const signedVaas = await Promise.all(
    vaaSequenceDatas.map((item) => {
      return fetchVaaFromWormholeRpcHosts({
        chainId: item.emitterChain,
        emitterAddress: item.emitterAddress.toString("hex"),
        sequence: item.sequence.toString(),
      });
    }),
  );

  return signedVaas;
}

async function getPostedVaas(connection: Connection, vaaAccountKeys: PublicKey[]): Promise<PostedVaaData[]> {
  const infos = await connection.getMultipleAccountsInfo(vaaAccountKeys, "confirmed");
  let postedVaas: any[] = [];
  for (const info of infos) {
    try {
      postedVaas.push(PostedVaaData.deserialize(getAccountData(info)));
    } catch (e) {
      continue;
    }
  }

  return postedVaas;
}

interface WrappedMetaDataKeys {
  key: PublicKey;
  signature: string;
  isTokenBridge: boolean;
}

async function getWrappedMeta(
  connection: Connection,
  metaKeys: WrappedMetaDataKeys[],
): Promise<(TokenWrappedMeta | NftWrappedMeta | undefined)[]> {
  const infos = await connection.getMultipleAccountsInfo(
    metaKeys.map((item) => item.key),
    "confirmed",
  );
  const wrappedMetas = infos.map((info, index) => {
    const metaKey = metaKeys[index];
    const isTokenBridge = metaKey.isTokenBridge;
    const data = info ? getAccountData(info) : undefined;

    return data ? (isTokenBridge ? TokenWrappedMeta.deserialize(data) : NftWrappedMeta.deserialize(data)) : undefined;
  });

  return wrappedMetas;
}

function parsePayloadAddress(buf: Buffer) {
  const bytesAddress = new Uint8Array(buf);

  return new PublicKey(bytesAddress).toString();
}

function parseAddress(buf: Buffer) {
  const paddedAddressUnit8Array = new Uint8Array(buf);
  const unpaddedAddressUnit8Array = ethers.utils.stripZeros(paddedAddressUnit8Array);
  const address = ethers.utils.hexlify(unpaddedAddressUnit8Array);

  return address;
}

function parseTokenBridgeTransferNativeData(data: string) {
  const decodedData = base58.decode(data);
  const paramsHex = Buffer.from(decodedData.subarray(1)).toString("hex");
  const paramsBuffer = Buffer.from(paramsHex, "hex");
  const nonce = paramsBuffer.readUInt32LE(0);
  const amount = paramsBuffer.readBigUInt64LE(4);
  const fee = paramsBuffer.readBigUInt64LE(12);
  // address > array > padded32array > string hex > buffer
  const targetAddressBuffer = paramsBuffer.subarray(20, 52);
  const targetAddress = parseAddress(targetAddressBuffer);
  const targetChain = paramsBuffer.readUInt16LE(52);

  return { nonce, amount, fee, targetAddress, targetChain };
}

function parseTokenBridgeTransferNativeWithPayloadData(data: string) {
  const decodedData = base58.decode(data);
  const paramsHex = Buffer.from(decodedData.subarray(1)).toString("hex");
  const paramsBuffer = Buffer.from(paramsHex, "hex");
  const nonce = paramsBuffer.readUInt32LE(0);
  const amount = paramsBuffer.readBigUInt64LE(4);
  // address > array > padded32array > string hex > buffer
  const targetAddressBuffer = paramsBuffer.subarray(12, 44);
  const targetAddress = parseAddress(targetAddressBuffer);
  const targetChain = paramsBuffer.readUInt16LE(44);
  const payloadLen = paramsBuffer.readUint32LE(46);
  const payload = paramsBuffer.subarray(50, 50 + payloadLen);

  return { nonce, amount, fee: undefined, targetAddress, targetChain, payload };
}

function parseNftBridgeTransferNativeData(data: string) {
  const decodedData = base58.decode(data);
  const paramsHex = Buffer.from(decodedData.subarray(1)).toString("hex");
  const paramsBuffer = Buffer.from(paramsHex, "hex");
  const nonce = paramsBuffer.readUInt32LE(0);
  // address > array > padded32array > string hex > buffer
  const targetAddressBuffer = paramsBuffer.subarray(4, 36);
  const targetAddress = parseAddress(targetAddressBuffer);
  const targetChain = paramsBuffer.readUInt16LE(36);

  return { nonce, targetAddress, targetChain };
}

// save evm token info from unwrapped source token address or source transfer dest token address
async function fetchEVMTokenInfo(evmTokensList: ExtendedTokenIdentity[]): Promise<IToken[]> {
  let newTokensToAdd: IToken[] = [];

  for (const evmToken of evmTokensList) {
    let destChain = evmToken.chainId as WormholeChainId;
    const destProvider = getEVMProviderWithWormholeChain(destChain);
    if (!destProvider) {
      continue;
    }

    let tokenInfo = evmToken.nft
      ? await getERC721Info(destProvider, evmToken.tokenAddress, destChain)
      : await getERC20Info(destProvider, evmToken.tokenAddress, destChain);

    if (tokenInfo) {
      newTokensToAdd.push(tokenInfo);
    }
  }
  return newTokensToAdd;
}

async function fetchSolanaTokenInfo(connection: Connection, solanaTokens: string[]): Promise<IToken[]> {
  const existedRecords = await TokenModel.find({ tokenAddress: { $in: solanaTokens } });
  const existedTokenAddresses = existedRecords.map((item) => item.tokenAddress);
  const newSolanaTokenAddresses = solanaTokens.filter((tokenAddress) => !existedTokenAddresses.includes(tokenAddress));

  const uniqueTokenAddresses = [...new Set(newSolanaTokenAddresses)];
  const mintKeys = uniqueTokenAddresses.map((item) => new PublicKey(item));
  const config = getSolanaUtilConfig(connection);

  const utl = new Client(config);
  const tokens = await utl.fetchMints(mintKeys);

  const tokenModals: IToken[] = tokens.map((item) => {
    return {
      tokenAddress: item.address,
      chainId: CHAIN_ID_SOLANA,
      name: item.name,
      symbol: item.symbol,
      decimals: item.decimals,
      updated: new Date(),
      created: new Date(),
    };
  });

  console.log("solana new token model insert: ", tokenModals.map((item) => item.tokenAddress).join(","));

  return tokenModals;
}

async function getTokensByChains(tokensList: BasicTokenIdentity[]) {
  let andFilter = [] as any;

  for (const tokenIdentity of tokensList) {
    andFilter.push({
      $and: [
        {
          tokenAddress: tokenIdentity.tokenAddress,
        },
        {
          chainId: tokenIdentity.chainId,
        },
      ],
    });
  }

  if (andFilter.length > 0) {
    return await TokenModel.find({
      $or: andFilter,
    });
  }
  return null;
}

async function syncRedeemTransactionToTransferTransaction(
  signedVaas: (SignedVaaResult | undefined)[],
  vaaAccountKeys: VaaAccountKey[],
) {
  console.log("syncRedeemTransactionToTransferTransaction: ", signedVaas.map((item) => item?.vaaBytes).join(","));

  let signedVaaHashs: string[] = [];

  for (const signedVAA of signedVaas) {
    if (signedVAA?.vaaBytes) {
      const vaaHash = getSignedVAAHash(Buffer.from(signedVAA?.vaaBytes, "base64"));
      signedVaaHashs.push(vaaHash);
    }
  }

  if (signedVaaHashs.length) {
    const transferTransactions = await TransactionModel.find({
      $and: [
        {
          signedVAAHash: {
            $in: signedVaaHashs,
          },
        },
        {
          $or: [{ txnType: TXN_TYPE.TOKEN_BRIDGE }, { txnType: TXN_TYPE.NFT_BRIDGE }],
        },
      ],
    });
    const changedTransferTransactionSignatures: string[] = [];

    for (let i = 0; i < signedVaaHashs.length; i++) {
      const vaaHash = signedVaaHashs[i];
      const redeemTransactionVaaAccountKey = vaaAccountKeys[i];
      const transferTransaction = transferTransactions.find((item) => vaaHash && item.signedVAAHash === vaaHash);

      if (vaaHash && redeemTransactionVaaAccountKey && transferTransaction) {
        transferTransaction.status = TXN_STATUS.REDEEMED;
        transferTransaction.redeemTxn = redeemTransactionVaaAccountKey.signature;
        transferTransaction.updated = new Date();

        changedTransferTransactionSignatures.push(transferTransaction.txn);
      }
    }

    const changedTransferTransactions = transferTransactions.filter((item) =>
      changedTransferTransactionSignatures.includes(item.txn),
    );

    if (changedTransferTransactions.length) {
      await TransactionModel.bulkSave(changedTransferTransactions);

      console.log(
        "solana transfer transaction changed: ",
        changedTransferTransactions.map((item) => `from: ${item.txn} to: ${item.redeemTxn}`).join(","),
      );
    }
  }
}

interface MetaKey {
  signature: string;
  isTokenBridge: boolean;
  metaKey: PublicKey;
}

async function indexTransactions(connection: Connection, transactions: Transaction[]) {
  console.log(
    `addTransactionsToDB running. total: ${transactions.length}, txns: `,
    transactions.map((item) => item.signature).join(","),
  );

  let successTransactions: Transaction[] = [];

  for (const solanaTxn of transactions) {
    if (solanaTxn.transactionResponse?.meta && solanaTxn.transactionResponse.meta.err) {
      // skip those with error
      continue;
    }
    successTransactions.push(solanaTxn);
  }

  const vaaAccountKeys = successTransactions
    .map((item) => {
      const vaaAccountKey = getVaaAccountKey(item);

      return vaaAccountKey;
    })
    .filter((item) => item != null) as VaaAccountKey[];

  const postedVaas = await getPostedVaas(
    connection,
    vaaAccountKeys.map((item) => item.vaaAccountKey),
  );
  const signedVaas = await getSignedVaasFromPostedVaas(postedVaas);
  const metaKeys = successTransactions
    .map((item) => {
      const metaKey = getMetaKey(item.programPubKey, item);

      return metaKey
        ? {
            signature: item.signature,
            isTokenBridge: item.programPubKey === tokenBridgePublicKey,
            metaKey,
          }
        : undefined;
    })
    .filter((item) => item != null) as MetaKey[];

  const wrappedMetas = await getWrappedMeta(
    connection,
    metaKeys.map((item) => {
      return {
        signature: item.signature,
        isTokenBridge: item.isTokenBridge,
        key: item.metaKey,
      };
    }),
  );

  const transactionModalPromises = successTransactions.map((item) => {
    const vaaAccountKeyIndex = vaaAccountKeys.findIndex((vaaAccountKey) => vaaAccountKey.signature === item.signature);
    const signedVaa = vaaAccountKeyIndex !== -1 ? signedVaas[vaaAccountKeyIndex] : undefined;
    const postedVaa = vaaAccountKeyIndex !== -1 ? postedVaas[vaaAccountKeyIndex] : undefined;
    const metaKeyIndex = metaKeys.findIndex((metaKey) => metaKey.signature === item.signature);
    const wrappedMeta = metaKeyIndex !== -1 ? wrappedMetas[metaKeyIndex] : undefined;

    return constructTransactionModal({
      transaction: item,
      postedVaa,
      wrappedMeta,
      signedVaaBytes: signedVaa ? signedVaa.vaaBytes : undefined,
    });
  });

  const transactionModals = (await Promise.all(transactionModalPromises)).filter((item) => item != null) as ITxn[];

  console.log("solana new transaction model created: ", JSON.stringify(transactionModals));

  if (transactionModals.length) {
    await addTransactionsToDB(transactionModals);

    console.log("solana new transaction model inserted: ", transactionModals.map((item) => item.txn).join(","));

    const { solanaTokensList, evmTokensList } = filterSolanaTokens(transactionModals);

    console.log("solana tokens info: ", JSON.stringify(solanaTokensList), JSON.stringify(evmTokensList));

    const evmTokensInfoList = await fetchEVMTokenInfo(evmTokensList);
    const solanaTokensInfoList = await fetchSolanaTokenInfo(connection, solanaTokensList);

    await addTokensToDB([...evmTokensInfoList, ...solanaTokensInfoList]);
    await syncRedeemTransactionToTransferTransaction(signedVaas, vaaAccountKeys);
  }
}

/**
 * filter a list of token address according to chain type
 * the list is used later to fetch and save the token info the the database
 * for evm chains we need the token address and chain id because different chains may have same token addresses
 * @param transactionModals
 * @returns JSON
 */
function filterSolanaTokens(transactionModals: Partial<ITxn>[]) {
  let solanaTokensList: string[] = [];
  let evmTokensList: ExtendedTokenIdentity[] = [];

  for (const txn of transactionModals) {
    // source transfer destTokenAddress is the computed foreign asset
    let nft = txn.txnType === TXN_TYPE.NFT_BRIDGE ? true : false;

    if (txn.sourceTokenAddress) {
      if ((txn.sourceChainId as WormholeChainId) === CHAIN_ID_SOLANA) {
        solanaTokensList.push(txn.sourceTokenAddress);
      } else if (isEVMChain(txn.sourceChainId as WormholeChainId) && txn.sourceChainId) {
        evmTokensList.push({
          tokenAddress: txn.sourceTokenAddress,
          chainId: txn.sourceChainId,
          nft,
        });
      }
    }

    if (txn.destTokenAddress && txn.destTokenAddress !== ethers.constants.AddressZero && txn.destChainId) {
      if ((txn.destChainId as WormholeChainId) === CHAIN_ID_SOLANA) {
        solanaTokensList.push(txn.destTokenAddress);
      } else if (isEVMChain(txn.destChainId as WormholeChainId)) {
        evmTokensList.push({
          tokenAddress: txn.destTokenAddress,
          chainId: txn.destChainId,
          nft,
        });
      }
    }

    if (txn.unwrappedSourceTokenAddress && txn.unwrappedSourceChainId) {
      if ((txn.unwrappedSourceChainId as WormholeChainId) === CHAIN_ID_SOLANA) {
        solanaTokensList.push(txn.unwrappedSourceTokenAddress);
      } else if (isEVMChain(txn.unwrappedSourceChainId as WormholeChainId)) {
        evmTokensList.push({
          tokenAddress: txn.unwrappedSourceTokenAddress,
          chainId: txn.unwrappedSourceChainId,
          nft,
        });
      }
    }
  }

  return {
    solanaTokensList,
    evmTokensList,
  };
}

// compute foreign asset for token bridge
async function computeForeignAsset(originAddress: string, originChain: WormholeChainId, destChain: WormholeChainId) {
  let destTokenAddress = ethers.constants.AddressZero;

  if (originChain === destChain) {
    destTokenAddress = originAddress;
  } else {
    try {
      const foreignAsset = await fetchForeignAsset(originAddress, originChain, destChain);
      if (foreignAsset && foreignAsset !== ethers.constants.AddressZero) {
        destTokenAddress = foreignAsset;
        if (isEVMChain(destChain)) {
          destTokenAddress = destTokenAddress.toLowerCase();
        }
      }
    } catch (err) {
      console.error("error computing foreign asset: ", err);
    }
  }
  return destTokenAddress;
}

async function getLastestIndexedTransaction(txnType: string) {
  const lastTxn = await TransactionModel.findOne({
    $and: [
      {
        sourceChainId: CHAIN_ID_SOLANA,
      },
      {
        txnType: txnType,
      },
    ],
  }).sort({ _id: -1 });
  return lastTxn;
}

export function getSolanaUtilConfig(connection: Connection) {
  const config = new UtlConfig({
    /**
     * 101 - mainnet, 102 - testnet, 103 - devnet
     */
    chainId: process.env.CLUSTER === "mainnet" ? ChainId.MAINNET : ChainId.DEVNET,
    /**
     * number of miliseconds to wait until falling back to CDN
     */
    timeout: 2000,
    /**
     * Solana web3 Connection
     */
    connection,
    /**
     * Backend API url which is used to query tokens
     */
    apiUrl: "https://token-list-api.solana.cloud",
    /**
     * CDN hosted static token list json which is used in case backend is down
     */
    cdnUrl: "https://cdn.jsdelivr.net/gh/solflare-wallet/token-list/solana-tokenlist.json",
  });
  return config;
}

interface TBTCTransaction {
  transaction: TransactionResponse;
  transactionSignature: string;
  instruction: CompiledInstruction;
  ix: AnchorInstruction;
  fmt: InstructionDisplay | null;
}

async function fetchTbtcValidTransactions(options: {
  connection: Connection;
  untilSignature?: string;
  beforeSignature?: string;
}) {
  const { connection, untilSignature, beforeSignature } = options;
  const solTbtcGateway = new PublicKey(getTBTCGatewayForChain(CHAIN_ID_SOLANA));
  const transactionsSigs = await connection.getSignaturesForAddress(solTbtcGateway, {
    until: !!untilSignature ? untilSignature : undefined,
    before: !!beforeSignature ? beforeSignature : undefined,
    limit: transactionLimit,
  });

  console.log("fetchTBTCValidTransactions: ", transactionsSigs.map((item) => item.signature).join(","));

  const records = await TransactionModel.find({ txn: { $in: transactionsSigs.map((item) => item.signature) } });
  const existedSignatures = records.map((item) => item.txn);
  const notExistedTransactions = transactionsSigs.filter(
    (transaction) => !existedSignatures.includes(transaction.signature),
  );

  const transactionSignatures = notExistedTransactions.map((item) => item.signature);

  const transactions = await connection.getTransactions(transactionSignatures);

  const coder = new BorshCoder(WormholeGatewayIdl);

  const validTransactions = transactions
    .map((tx, index) => {
      if (tx) {
        const instruction = tx.transaction.message.instructions.find((item) => {
          const accountKey = tx.transaction.message.accountKeys[item.programIdIndex];
          return accountKey.toString() === getTBTCGatewayForChain(CHAIN_ID_SOLANA);
        });

        if (instruction) {
          const ix = coder.instruction.decode(instruction.data, "base58");

          if (ix) {
            const accountMetas = instruction.accounts.map((idx) => ({
              pubkey: tx.transaction.message.accountKeys[idx],
              isSigner: tx.transaction.message.isAccountSigner(idx),
              isWritable: tx.transaction.message.isAccountWritable(idx),
            }));
            const fmt = coder.instruction.format(ix, accountMetas);

            return { transaction: tx, transactionSignature: transactionSignatures[index], instruction, ix, fmt };
          }
        }
      }
    })
    .filter((item) => item != null) as TBTCTransaction[];

  return { allTransactionSignatures: transactionSignatures, validTransactions };
}

async function constructTBTCTransactionModal(options: {
  tbtcTransaction: TBTCTransaction;
  tbtcMint: string;
  ethTbtcAddress: string;
  postedVaa?: PostedVaaData;
  wrappedMeta?: TokenWrappedMeta;
  signedVaaBytes?: string;
}): Promise<ITxn | undefined> {
  const { tbtcTransaction, tbtcMint, ethTbtcAddress, postedVaa, wrappedMeta, signedVaaBytes } = options;
  const { transaction, transactionSignature, ix, fmt } = tbtcTransaction;

  if (ix.name === "sendTbtcGateway" || ix.name === "sendTbtcWrapped") {
    const sender = fmt?.accounts.find((item) => item.name === "Sender")?.pubkey;
    const recipientChain = (ix.data as any).args.recipientChain as WormholeChainId;
    const recipientUint8Array = (ix.data as any).args.recipient as Uint8Array;
    const recipient =
      recipientChain && recipientUint8Array ? tryUint8ArrayToNative(recipientUint8Array, recipientChain) : undefined;
    const amount = (ix.data as any).args.amount as WormholeChainId;
    const sequence =
      transaction && transaction.meta && transaction.meta.logMessages
        ? parseSequenceFromLogSolana(transaction.meta.logMessages)
        : undefined;
    const unwrappedSourceTokenAddress = ethTbtcAddress; // unwrapped source token address
    const unwrappedSourceChainId = CHAIN_ID_ETH;
    const destChainId = recipientChain;
    const destWrappedTokenAddress =
      unwrappedSourceTokenAddress && unwrappedSourceChainId
        ? await computeForeignAsset(
            unwrappedSourceTokenAddress,
            unwrappedSourceChainId as WormholeChainId,
            destChainId as WormholeChainId,
          )
        : undefined;
    const destTokenAddress =
      getWtBTCAddressForChain(destChainId).toLowerCase() === destWrappedTokenAddress?.toLowerCase()
        ? getTBTCGatewayForChain(destChainId)
        : destWrappedTokenAddress;

    if (sender && recipient && amount && sequence && destTokenAddress) {
      const txn: ITxn = {
        txnType: TXN_TYPE.TOKEN_BRIDGE,
        txn: transactionSignature,
        sender: sender.toString(),
        recipient,
        arbiterFee: "0",
        isSourceNative: false,
        sourceTokenAddress: tbtcMint, // wrapped token address
        sourceChainId: chainId, // wrapped token chain
        unwrappedSourceTokenAddress, // unwrapped source token address
        unwrappedSourceChainId, // unwrapped source chain
        destChainId,
        destTokenAddress,
        emitterAddress: deriveWormholeEmitterKey(tokenBridgePublicKey).toBuffer().toString("hex"),
        wormholeSequence: sequence,
        tokenAmt: amount.toString(),
        status: TXN_STATUS.PENDING,
        updated: new Date(),
        created: new Date(),
      };

      return txn;
    }
  } else if (ix.name === "receiveTbtc") {
    const payer = fmt?.accounts.find((item) => item.name === "Payer")?.pubkey;
    const recipientToken = fmt?.accounts.find((item) => item.name === "Recipient Token")?.pubkey;

    if (payer && recipientToken && postedVaa && wrappedMeta && signedVaaBytes) {
      const payload = parseTokenTransferPayload(postedVaa.message.payload);
      const tokenBridgeRegisteredEmitter = deriveTokenEndpointKey(
        tokenBridgePublicKey,
        postedVaa.message.emitterChain,
        postedVaa.message.emitterAddress,
      );
      const sourceChainId = postedVaa.message.emitterChain;
      const sourceWrappedTokenAddress = await computeForeignAsset(
        tryUint8ArrayToNative(payload.tokenAddress, payload.tokenChain as WormholeChainId),
        payload.tokenChain as WormholeChainId,
        sourceChainId as WormholeChainId,
      );
      const sourceTokenAddress =
        getWtBTCAddressForChain(sourceChainId as WormholeChainId).toLowerCase() ===
        sourceWrappedTokenAddress.toLowerCase()
          ? getTBTCAddressForChain(sourceChainId as WormholeChainId)
          : sourceWrappedTokenAddress;

      const txn: ITxn = {
        txnType: TXN_TYPE.REDEEM,
        txn: transactionSignature,
        sender: payer.toString(),
        recipient: recipientToken.toString(),
        isSourceNative: false,
        unwrappedSourceTokenAddress: parseAddress(wrappedMeta.tokenAddress), // unwrapped token address
        unwrappedSourceChainId: wrappedMeta.chain, // unwrapped token chain
        sourceTokenAddress,
        sourceChainId,
        destTokenAddress: tbtcMint,
        destChainId: chainId,
        emitterAddress: tokenBridgeRegisteredEmitter.toString(),
        wormholeSequence: postedVaa.message.sequence.toString(),
        tokenAmt: payload.amount.toString(),
        signedVAABytes: signedVaaBytes,
        signedVAAHash: getSignedVAAHash(Buffer.from(signedVaaBytes, "base64")),
        status: TXN_STATUS.CONFIRMED,
        updated: new Date(),
        created: new Date(),
      };

      return txn;
    }
  }
}

async function indexTBTCTransactions(connection: Connection, transactions: TBTCTransaction[]) {
  console.log(
    `addTBTCTransactionsToDB running. total: ${transactions.length}, txns: `,
    transactions.map((item) => item.transactionSignature).join(","),
  );

  let successTransactions: TBTCTransaction[] = [];

  for (const solanaTxn of transactions) {
    if (solanaTxn.transaction?.meta && solanaTxn.transaction.meta.err) {
      // skip those with error
      continue;
    }
    successTransactions.push(solanaTxn);
  }

  const tbtcMint = getTBTCAddressForChain(CHAIN_ID_SOLANA);
  const wtbtcMint = getWtBTCAddressForChain(CHAIN_ID_SOLANA);
  const ethTbtcAddress = getTBTCAddressForChain(CHAIN_ID_ETH);
  const vaaAccountKeys = successTransactions
    .map((item) => {
      const vaaAccountKey =
        item.ix.name === "receiveTbtc"
          ? item.fmt?.accounts.find((item) => item.name === "Posted Vaa")?.pubkey
          : undefined;

      return vaaAccountKey ? { vaaAccountKey, signature: item.transactionSignature } : undefined;
    })
    .filter((item) => item != null) as VaaAccountKey[];

  const postedVaas = await getPostedVaas(
    connection,
    vaaAccountKeys.map((item) => item.vaaAccountKey),
  );
  const signedVaas = await getSignedVaasFromPostedVaas(postedVaas);
  const wrappedMetaKey = deriveWrappedMetaKey(tokenBridgePublicKey, wtbtcMint);
  const wrappedMetas = await getWrappedMeta(connection, [
    {
      signature: "",
      isTokenBridge: true,
      key: wrappedMetaKey,
    },
  ]);

  const transactionModalPromises = successTransactions.map((item) => {
    const vaaAccountKeyIndex = vaaAccountKeys.findIndex(
      (vaaAccountKey) => vaaAccountKey.signature === item.transactionSignature,
    );
    const signedVaa = vaaAccountKeyIndex !== -1 ? signedVaas[vaaAccountKeyIndex] : undefined;
    const postedVaa = vaaAccountKeyIndex !== -1 ? postedVaas[vaaAccountKeyIndex] : undefined;

    return constructTBTCTransactionModal({
      tbtcTransaction: item,
      tbtcMint,
      ethTbtcAddress,
      postedVaa,
      wrappedMeta: wrappedMetas[0] && !("tokenId" in wrappedMetas[0]) ? wrappedMetas[0] : undefined,
      signedVaaBytes: signedVaa?.vaaBytes,
    });
  });

  const transactionModals = (await Promise.all(transactionModalPromises)).filter((item) => item != null) as ITxn[];

  console.log("solana new tbtc transaction model created: ", JSON.stringify(transactionModals));

  if (transactionModals.length) {
    await addTransactionsToDB(transactionModals);

    console.log("solana new tbtc transaction model inserted: ", transactionModals.map((item) => item.txn).join(","));

    const { solanaTokensList, evmTokensList } = filterSolanaTokens(transactionModals);

    console.log("solana tbtc tokens info: ", JSON.stringify(solanaTokensList), JSON.stringify(evmTokensList));

    const evmTokensInfoList = await fetchEVMTokenInfo(evmTokensList);
    const solanaTokensInfoList = await fetchSolanaTokenInfo(connection, solanaTokensList);

    await addTokensToDB([...evmTokensInfoList, ...solanaTokensInfoList]);
    await syncRedeemTransactionToTransferTransaction(signedVaas, vaaAccountKeys);
  }
}

interface USDCTransaction {
  transaction: TransactionResponse;
  transactionSignature: string;
  instruction: MessageCompiledInstruction;
  ix: AnchorInstruction;
  fmt: InstructionDisplay | null;
}

async function fetchUSDCValidTransactions(options: {
  connection: Connection;
  untilSignature?: string;
  beforeSignature?: string;
}) {
  const { connection, untilSignature, beforeSignature } = options;
  const solanaNetworkConfigs = cctpSDK.configs.networks.find((item) => item.domain === CCTPDomain.Solana);

  if (!solanaNetworkConfigs) {
    throw new Error("Solana cctp network configs not found");
  }

  const solUSDCProgramPubkey = new PublicKey(solanaNetworkConfigs.cctpMessengerContractAddress);
  const transactionsSigs = await connection.getSignaturesForAddress(solUSDCProgramPubkey, {
    until: !!untilSignature ? untilSignature : undefined,
    before: !!beforeSignature ? beforeSignature : undefined,
    limit: transactionLimit,
  });

  const records = await TransactionModel.find({ txn: { $in: transactionsSigs.map((item) => item.signature) } });
  const existedSignatures = records.map((item) => item.txn);
  const notExistedTransactions = transactionsSigs.filter(
    (transaction) => !existedSignatures.includes(transaction.signature),
  );

  const transactionSignatures = notExistedTransactions.map((item) => item.signature);

  console.log("fetchUSDCValidTransactions: ", transactionSignatures);

  const transactions = await connection.getTransactions(transactionSignatures, { maxSupportedTransactionVersion: 0 });

  const messengerCoder = new BorshCoder(CCTPTokenMessengerMinterIdl);
  const messageTransmitterCoder = new BorshCoder(CCTPMessageTransmitterIdl);

  const validTransactions = transactions
    .map((tx, index) => {
      if (tx) {
        const accountKeys = tx.transaction.message.getAccountKeys();
        const instruction = tx.transaction.message.compiledInstructions.find((item) => {
          const accountKey = accountKeys.get(item.programIdIndex);

          return (
            accountKey?.toString() === solanaNetworkConfigs.cctpMessengerContractAddress ||
            accountKey?.toString() === solanaNetworkConfigs.cctpMessageTransmitterContractAddress
          );
        });

        if (instruction) {
          const accountKey = accountKeys.get(instruction.programIdIndex);
          const isMessenger = accountKey?.toString() === solanaNetworkConfigs.cctpMessengerContractAddress;
          const ix = (isMessenger ? messengerCoder : messageTransmitterCoder).instruction.decode(
            Buffer.from(instruction.data),
            "base58",
          );

          if (ix) {
            const accountMetas = instruction.accountKeyIndexes.map((idx) => {
              return {
                pubkey: accountKeys.get(idx) as PublicKey,
                isSigner: tx.transaction.message.isAccountSigner(idx),
                isWritable: tx.transaction.message.isAccountWritable(idx),
              };
            });

            const fmt = (isMessenger ? messengerCoder : messageTransmitterCoder).instruction.format(ix, accountMetas);

            return { transaction: tx, transactionSignature: transactionSignatures[index], instruction, ix, fmt };
          }
        }
      }
    })
    .filter((item) => item != null) as USDCTransaction[];

  return { allTransactionSignatures: transactionSignatures, validTransactions };
}

async function constructUSDCTransactionModal(options: {
  transaction: USDCTransaction;
  message: Buffer;
}): Promise<ITxn | undefined> {
  const { transaction, message } = options;
  const { transactionSignature, ix } = transaction;

  const { messageSender, mintRecipient, burnToken, sourceDomain, destinationDomain, nonce, amount } = decodeMessage({
    messageHex: ethers.utils.hexlify(message),
  });

  console.log(
    "constructUSDCTransactionModal",
    "0x" + message.toString("hex"),
    ethers.utils.hexlify(message),
    transaction.transactionSignature,
    messageSender,
    mintRecipient,
    burnToken,
    sourceDomain,
    destinationDomain,
    nonce,
    amount,
  );

  let sourceChainId: WormholeChainId | undefined;

  try {
    sourceChainId = getChainIdByDomain(sourceDomain);
  } catch (e) {
    console.error(e);
  }

  let destChainId: WormholeChainId | undefined;

  try {
    destChainId = getChainIdByDomain(destinationDomain);
  } catch (e) {
    console.error(e);
  }

  if (sourceChainId == null || destChainId == null) {
    return;
  }

  const cctpConfigs = getCCTPNetworkConfigs({ sourceChainId, targetChainId: destChainId });

  if (!cctpConfigs) {
    return;
  }

  const txn: ITxn = {
    txnType: ix.name === "depositForBurn" ? TXN_TYPE.TOKEN_BRIDGE : TXN_TYPE.REDEEM,
    txn: transactionSignature,
    sender: messageSender,
    recipient: mintRecipient,
    arbiterFee: "0",
    isSourceNative: false,
    sourceTokenAddress: burnToken, // wrapped token address
    sourceChainId: sourceChainId, // wrapped token chain
    unwrappedSourceTokenAddress: burnToken, // unwrapped source token address
    unwrappedSourceChainId: sourceChainId, // unwrapped source chain
    destChainId,
    destTokenAddress: cctpConfigs.cctpTargetNetworkConfigs.usdcContractAddress,
    tokenAmt: amount,
    cctpHashedSourceAndNonce: hashSourceChainAndNonce(sourceDomain, BigNumber.from(nonce)),
    status: TXN_STATUS.CONFIRMED,
    updated: new Date(),
    created: new Date(),
  };

  return txn;
}

function parseMessageSentEventData(data: Buffer) {
  const messageTransmitterCoder = new BorshCoder(CCTPMessageTransmitterIdl);

  const parsedEvent = messageTransmitterCoder.accounts.decode("MessageSent", data);

  return parsedEvent;
}

async function getMessages(
  connection: Connection,
  messageAccountKeys: {
    txHash: string;
    messageAccount: PublicKey;
  }[],
): Promise<{ txHash: string; message: Buffer }[]> {
  const accountKeys = messageAccountKeys.map((item) => item.messageAccount);
  const infos = await connection.getMultipleAccountsInfo(accountKeys, "confirmed");
  const message: { txHash: string; message: Buffer }[] = [];

  if (infos) {
    for (let i = 0; i < infos.length; i++) {
      try {
        const info = infos[i];
        if (info) {
          message.push({ txHash: messageAccountKeys[i].txHash, message: parseMessageSentEventData(info.data).message });
        }
      } catch (e) {
        continue;
      }
    }
  }

  return message;
}

async function indexUSDCTransactions(connection: Connection, transactions: USDCTransaction[]) {
  console.log(
    `addUSDCTransactionsToDB running. total: ${transactions.length}, txns: `,
    transactions.map((item) => item.transactionSignature).join(","),
  );

  let successTransactions: USDCTransaction[] = [];

  for (const solanaTxn of transactions) {
    if (solanaTxn.transaction?.meta && solanaTxn.transaction.meta.err) {
      // skip those with error
      continue;
    }
    successTransactions.push(solanaTxn);
  }

  const transferTransactions = successTransactions.filter((item) => item.ix.name === "depositForBurn");
  const redemptionTransactions = successTransactions.filter((item) => item.ix.name === "receiveMessage");
  const redemptionTransactionMessages = redemptionTransactions.map((item) => {
    return { txHash: item.transactionSignature, message: (item.ix.data as any).params.message };
  });

  const transferMessageAccounts = transferTransactions
    .map((item) => {
      return {
        txHash: item.transactionSignature,
        messageAccount: item.fmt?.accounts.find((item) => item.name === "Message Sent Event Data")?.pubkey,
      };
    })
    .filter((item) => item.messageAccount != null) as { txHash: string; messageAccount: PublicKey }[];

  const transferMessagesWithTxHash = await getMessages(connection, transferMessageAccounts);
  const messagesWithTxHash = transferMessagesWithTxHash.concat(redemptionTransactionMessages);
  const transactionModalPromises = successTransactions.map((item) => {
    const message = messagesWithTxHash.find((message) => message.txHash === item.transactionSignature);

    if (message) {
      return constructUSDCTransactionModal({
        transaction: item,
        message: message.message,
      });
    }
  });

  const transactionModals = (await Promise.all(transactionModalPromises.filter((item) => item != null))).filter(
    (item) => item != null,
  ) as ITxn[];

  console.log("solana new usdc transaction model created: ", JSON.stringify(transactionModals));

  if (transactionModals.length) {
    await addTransactionsToDB(transactionModals);

    console.log("solana new usdc transaction model inserted: ", transactionModals.map((item) => item.txn).join(","));

    const { solanaTokensList, evmTokensList } = filterSolanaTokens(transactionModals);

    console.log("solana usdc tokens info: ", JSON.stringify(solanaTokensList), JSON.stringify(evmTokensList));

    const evmTokensInfoList = await fetchEVMTokenInfo(evmTokensList);
    const solanaTokensInfoList = await fetchSolanaTokenInfo(connection, solanaTokensList);

    await addTokensToDB([...evmTokensInfoList, ...solanaTokensInfoList]);
    await linkTransferToRedeemTransactionInBatch(transactionModals.filter((item) => item.txnType === TXN_TYPE.REDEEM));
  }
}

async function linkTransferToRedeemTransactionInBatch(redeemTxns: ITxn[]) {
  const cctpHashedSourceAndNonce = redeemTxns.map((item) => item.cctpHashedSourceAndNonce);
  const modifiedTransferTxns: Document[] = [];
  const transferTxns = await TransactionModel.find({
    $and: [
      { txnType: TXN_TYPE.TOKEN_BRIDGE },
      {
        cctpHashedSourceAndNonce: {
          $in: cctpHashedSourceAndNonce,
        },
      },
    ],
  });

  if (transferTxns.length && redeemTxns.length) {
    transferTxns.forEach((item) => {
      const redeemTxn = redeemTxns.find(
        (redeemItem) => item.cctpHashedSourceAndNonce === redeemItem.cctpHashedSourceAndNonce,
      );
      if (redeemTxn) {
        item.redeemTxn = redeemTxn.txn;
        item.status = TXN_STATUS.REDEEMED;
        item.updated = new Date();
        modifiedTransferTxns.push(item);
      }
    });
  }

  if (modifiedTransferTxns.length > 0) {
    // console.log("modified txns: ", modifiedTransferTxns);
    await TransactionModel.bulkSave(modifiedTransferTxns);
  }
}

async function getLatestTokenBridgeTransactionHash() {
  if (!latestTokenBridgeTransactionSignature) {
    const now = dayjs().unix();
    const solanaTokenBridgeEarliestTxHashEffectiveBefore =
      process.env.SOLANA_TOKEN_BRIDGE_EARLIEST_TX_HASH_EFFECTIVE_BEFORE;
    const isSolanaTokenBridgeEarliestTxHashEffective = solanaTokenBridgeEarliestTxHashEffectiveBefore
      ? now < parseInt(solanaTokenBridgeEarliestTxHashEffectiveBefore)
      : false;

    console.log("timestamp", now);
    console.log("solanaTokenBridgeEarliestTxHashEffectiveBefore", solanaTokenBridgeEarliestTxHashEffectiveBefore);
    console.log("isSolanaTokenBridgeEarliestTxHashEffective", isSolanaTokenBridgeEarliestTxHashEffective);
    console.log("SOLANA_TOKEN_BRIDGE_EARLIEST_TX_HASH", process.env.SOLANA_TOKEN_BRIDGE_EARLIEST_TX_HASH);

    if (isSolanaTokenBridgeEarliestTxHashEffective && process.env.SOLANA_TOKEN_BRIDGE_EARLIEST_TX_HASH) {
      latestTokenBridgeTransactionSignature = process.env.SOLANA_TOKEN_BRIDGE_EARLIEST_TX_HASH;
    } else {
      // fetch the last indexed transaction from indexer
      const lastTxn = await getLastestIndexedTransaction(TXN_TYPE.TOKEN_BRIDGE);

      if (lastTxn) {
        latestTokenBridgeTransactionSignature = lastTxn.txn;
      }
    }
  }

  return latestTokenBridgeTransactionSignature;
}

async function getLatestUSDCTransactionHash() {
  if (!latestUSDCTransactionSignature) {
    const now = dayjs().unix();
    const solanaUSDCEarliestTxHashEffectiveBefore = process.env.SOLANA_USDC_EARLIEST_TX_HASH_EFFECTIVE_BEFORE;
    const isSolanaUSDCEarliestTxHashEffective = solanaUSDCEarliestTxHashEffectiveBefore
      ? now < parseInt(solanaUSDCEarliestTxHashEffectiveBefore)
      : false;

    console.log("timestamp", now);
    console.log("solanaUSDCEarliestTxHashEffectiveBefore", solanaUSDCEarliestTxHashEffectiveBefore);
    console.log("isSolanaUSDCEarliestTxHashEffective", isSolanaUSDCEarliestTxHashEffective);
    console.log("SOLANA_USDC_EARLIEST_TX_HASH", process.env.SOLANA_USDC_EARLIEST_TX_HASH);

    if (isSolanaUSDCEarliestTxHashEffective && process.env.SOLANA_USDC_EARLIEST_TX_HASH) {
      latestUSDCTransactionSignature = process.env.SOLANA_USDC_EARLIEST_TX_HASH;
    } else {
      // fetch the last indexed transaction from indexer
      const lastTxn = await getLastestIndexedTransaction(TXN_TYPE.TOKEN_BRIDGE);

      if (lastTxn) {
        latestUSDCTransactionSignature = lastTxn.txn;
      }
    }
  }

  return latestUSDCTransactionSignature;
}

async function getLatestTBTCTransactionHash() {
  if (!latestTBTCTransactionSignature) {
    const now = dayjs().unix();
    const solanaTBTCEarliestTxHashEffectiveBefore = process.env.SOLANA_TBTC_EARLIEST_TX_HASH_EFFECTIVE_BEFORE;
    const isSolanaTBTCEarliestTxHashEffective = solanaTBTCEarliestTxHashEffectiveBefore
      ? now < parseInt(solanaTBTCEarliestTxHashEffectiveBefore)
      : false;

    console.log("timestamp", now);
    console.log("solanaTBTCEarliestTxHashEffectiveBefore", solanaTBTCEarliestTxHashEffectiveBefore);
    console.log("isSolanaTBTCEarliestTxHashEffective", isSolanaTBTCEarliestTxHashEffective);
    console.log("SOLANA_TBTC_EARLIEST_TX_HASH", process.env.SOLANA_TBTC_EARLIEST_TX_HASH);

    if (isSolanaTBTCEarliestTxHashEffective && process.env.SOLANA_TBTC_EARLIEST_TX_HASH) {
      latestTBTCTransactionSignature = process.env.SOLANA_TBTC_EARLIEST_TX_HASH;
    } else {
      // fetch the last indexed transaction from indexer
      const lastTxn = await getLastestIndexedTransaction(TXN_TYPE.TOKEN_BRIDGE);

      if (lastTxn) {
        latestTBTCTransactionSignature = lastTxn.txn;
      }
    }
  }

  return latestTBTCTransactionSignature;
}

export async function syncSolana() {
  console.log("sync solana token bridge started");
  await syncTokenBridgeNewTransactions();
  console.log("sync solana token bridge ended");
  console.log("sync solana nft bridge started");
  await syncNftBridgeNewTransactions();
  console.log("sync solana nft bridge ended");

  console.log("sync solana tbtc started");
  await syncTBTCNewTransactions();
  console.log("sync solana tbtc ended");

  console.log("sync solana usdc started");
  await syncUSDCNewTransactions();
  console.log("sync solana usdc ended");
}
