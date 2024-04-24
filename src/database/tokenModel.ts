import { Schema, model } from "mongoose";
import { addDBMetrics } from "./metrics";

export interface IToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  decimals?: number;
  chainId: number;
  created: Date;
  updated: Date;
}

const schema = new Schema<IToken>({
  tokenAddress: String,
  name: String,
  symbol: String,
  decimals: Number,
  chainId: Number,
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now },
});

schema.index({ chainId: 1, tokenAddress: 1 }, { unique: true });

addDBMetrics({ schema, model: "tokens" });

export const TokenModel = model("tokens", schema);
