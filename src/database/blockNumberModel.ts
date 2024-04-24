import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";

export enum TransactionType {
  Transfer,
  Redemption,
}

export interface IBlockNumber {
  type: TransactionType;
  latestIndexedBlockNumber: number;
  chainId: number;
  created: Date;
  updated: Date;
}

const schema = new Schema<IBlockNumber>({
  type: Number,
  latestIndexedBlockNumber: Number,
  chainId: Number,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

schema.index({ chainId: 1, type: 1 }, { unique: true });

addDBMetrics({ schema, model: "block-number" });

export const BlockNumber = model("block-number", schema);
