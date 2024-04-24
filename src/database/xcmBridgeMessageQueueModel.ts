import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";

export enum XCM_BRIDGE_TYPE {
  Transfer = "transfer",
  Redemption = "redemption",
}

export enum MESSAGE_STATUS {
  SUCCESS = "success",
  FAILED = "failed",
}

export interface IXCMBridgeMessageQueue {
  type: XCM_BRIDGE_TYPE;
  accountId: string;
  messageHash: string;
  parachainId: number;
  assetId: string;
  parachainBlockHash: string;
  parachainExtrinsicHash: string;
  amount: string;
  relatedMessageHash: string;
  xcmStatus: MESSAGE_STATUS;
  created: Date;
  updated: Date;
}

const schema = new Schema<IXCMBridgeMessageQueue>({
  type: String,
  accountId: String,
  messageHash: String,
  parachainId: Number,
  assetId: String,
  parachainBlockHash: String,
  parachainExtrinsicHash: String,
  amount: String,
  relatedMessageHash: String,
  xcmStatus: String,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

addDBMetrics({ schema, model: "xcm-bridge-message-queue" });

// collection name
export const XCMBridgeMessageQueueModel = model("xcm-bridge-message-queue", schema);
