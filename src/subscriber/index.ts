import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

import { connectDB } from "../database/connection";
import { getMetrics } from "../server/controller";
import express from "express";
import {
  getLatestMoonbeamSubscriptionResponseTime,
  getLatestParachaianSubscriptionResponseTime,
  setLatestMoonbeamSubscriptionResponseTime,
  setLatestParachaianSubscriptionResponseTime,
  subscribePolkachainExtrinsicResult,
} from "./polkachain";
import { CLUSTER, MOONBEAM_PARACHAIN_ID, Polkachain } from "../bridge";

const pollingTimeout = 60 * 60 * 1000;

/**
 * subscribe to contract events
 * decode the events and save the transactions to database
 */
async function initSubscriber() {
  await connectDB();

  const enabledPolkachains =
    process.env.ENABLED_POLKA_CHAIN != null
      ? process.env.ENABLED_POLKA_CHAIN.split(",").map((item) => parseInt(item))
      : CLUSTER === "mainnet"
      ? [Polkachain.HydraDX, Polkachain.Interlay]
      : [Polkachain.HydraDX, Polkachain.Interlay, Polkachain.PeaqAgung];
  subscribePolkachainExtrinsicResult({ polkachainIds: enabledPolkachains });

  setInterval(() => {
    for (let polkachainId of enabledPolkachains) {
      if (
        getLatestParachaianSubscriptionResponseTime(polkachainId) &&
        getLatestParachaianSubscriptionResponseTime(polkachainId) + pollingTimeout < Date.now()
      ) {
        console.error(`Parachain subscription timeout, chainId: ${polkachainId}`);
      }

      if (
        getLatestMoonbeamSubscriptionResponseTime() &&
        getLatestMoonbeamSubscriptionResponseTime() + pollingTimeout < Date.now()
      ) {
        console.error(`Parachain subscription timeout, chainId: ${MOONBEAM_PARACHAIN_ID}`);
      }
    }
  }, 60 * 1000);
}

initSubscriber();

const port = process.env.PORT ?? 27003;
const app = express();

app.use(express.json());

app.get("/metrics", [getMetrics]);

const server = app.listen(port, function () {
  console.log(`subscriber metrics - REST API server listening at ${port}`);
});
