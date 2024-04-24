import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";
import { ChainId } from "../utils/wormhole";

export interface IMrlRedemptionTxn {
  txn: string;
  mrlPayloadBytes: string;
  emitterChain: ChainId;
  emitterAddress: string;
  sequence: string;
  created: Date;
  updated: Date;
}

const schema = new Schema<IMrlRedemptionTxn>({
  txn: String,
  mrlPayloadBytes: String,
  emitterChain: Number,
  emitterAddress: String,
  sequence: String,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

addDBMetrics({ schema, model: "mrl-redemption-transactions" });

// collection name
export const MrlRedemptionTransactionModel = model("mrl-redemption-transactions", schema);
