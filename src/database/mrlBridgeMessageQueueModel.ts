import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";

export enum MESSAGE_STATUS {
  SUCCESS = "success",
  FAILED = "failed",
}

export interface IMRLBridgeMessageQueue {
  accountId: string;
  messageHash: string;
  moonbeamBlockHash?: string;
  moonbeamExtrinsicHash?: string;
  moonbeamTransactionHash?: string;
  parachainId: number;
  parachainBlockHash?: string;
  parachainExtrinsicHash?: string;
  transferSender?: string;
  transferSourceChainId?: number;
  vaaBytes?: string;
  xcmStatus: MESSAGE_STATUS;
  created: Date;
  updated: Date;
}

const schema = new Schema<IMRLBridgeMessageQueue>({
  accountId: String,
  messageHash: String,
  moonbeamBlockHash: String,
  moonbeamExtrinsicHash: String,
  moonbeamTransactionHash: String,
  parachainId: Number,
  parachainBlockHash: String,
  parachainExtrinsicHash: String,
  transferSender: String,
  transferSourceChainId: Number,
  vaaBytes: String,
  xcmStatus: String,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

addDBMetrics({ schema, model: "mrl-bridge-message-queue" });

// collection name
export const MRLBridgeMessageQueueModel = model("mrl-bridge-message-queue", schema);
