import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";

export interface ITxn {
  txnType: string;
  txn: string;
  sender: string;
  recipient: string;
  tokenId?: string; // for nft
  tokenAmt: string; // token amount may be a normalized value and not native decimals, see wormhole Bridge.sol normalizeAmount
  swapInAmt?: string; // for swap
  swapOutAmt?: string; // for swap
  isSourceNative?: boolean; // track if source is native currency
  arbiterFee?: string; // for token bridge; may be a normalized value like tokenAmt
  unwrappedSourceTokenAddress?: string; // for token bridge; when transfer from source, the wormhole event will output tokenAddress and tokenChain, these two values might be generated if the source is wormhole wrapped
  unwrappedSourceChainId?: number;
  sourceTokenAddress: string;
  sourceChainId: number;
  destTokenAddress: string;
  destChainId: number;
  wormholeSequence?: string;
  twoFASequence?: string; // for nft
  emitterAddress?: string;
  twoFAEmitterAddress?: string; // for nft
  signedVAABytes?: string;
  signedVAAHash?: string; // internal vaa hash to uniquely identify the VAA contents
  twoFASignedVAABytes?: string; // for nft
  cctpHashedSourceAndNonce?: string;
  redeemTxn?: string;
  status: string;
  created: Date;
  updated: Date;
}

const schema = new Schema<ITxn>({
  txnType: String,
  txn: String,
  sender: String,
  recipient: String,
  tokenId: String,
  tokenAmt: String,
  swapInAmt: String,
  swapOutAmt: String,
  arbiterFee: String,
  isSourceNative: Boolean,
  unwrappedSourceTokenAddress: String,
  unwrappedSourceChainId: Number,
  sourceTokenAddress: String,
  sourceChainId: Number,
  destTokenAddress: String,
  destChainId: Number,
  wormholeSequence: String,
  twoFASequence: String,
  emitterAddress: String,
  twoFAEmitterAddress: String,
  signedVAABytes: String,
  signedVAAHash: String,
  twoFASignedVAABytes: String,
  cctpHashedSourceAndNonce: String,
  redeemTxn: String,
  status: String,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

schema.index({ sourceChainId: 1, txn: 1, destChainId: 1 }, { unique: true });

addDBMetrics({ schema, model: "transactions" });

// collection name
export const TransactionModel = model("transactions", schema);
