import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";
import { TransactionType } from "./blockNumberModel";

export enum ManualIndexedTransactionStatus {
  Pending,
  Processing,
  Success,
  Failed,
}

export interface IManualIndexedTransactions {
  type: TransactionType;
  chainId: number;
  hash: string;
  status: ManualIndexedTransactionStatus;
  created: Date;
  updated: Date;
}

const schema = new Schema<IManualIndexedTransactions>({
  type: Number,
  chainId: Number,
  hash: String,
  status: Number,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

addDBMetrics({ schema, model: "manual-indexed-transactions" });

export const ManualIndexedTransactions = model("manual-indexed-transactions", schema);
