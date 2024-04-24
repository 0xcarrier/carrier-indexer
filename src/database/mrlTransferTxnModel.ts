import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";
import { ChainId } from "../utils/wormhole";

export interface IMrlTransferTxn {
  txn: string;
  ethTxn: string;
  sender: string;
  sourceChainId: ChainId;
  created: Date;
  updated: Date;
}

const schema = new Schema<IMrlTransferTxn>({
  txn: String,
  ethTxn: String,
  sender: String,
  sourceChainId: Number,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

addDBMetrics({ schema, model: "mrl-transfer-transactions" });

// collection name
export const MrlTransferTransactionModel = model("mrl-transfer-transactions", schema);
