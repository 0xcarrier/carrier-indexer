import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

import { CronJob } from "cron";
import { connectDB } from "../database/connection";
import { checkRedeemed } from "./check-redeemed";
import { syncSolana } from "./sync-solana";
import express from "express";
import { getMetrics } from "../server/controller";
import { startEVMIndexer } from "../evm-poller/sync-evm";
import { fetchVAAs } from "../vaa-poller/poll-vaa";

/**
 * grab the list of pending transactions
 * poll vaa from wormhole guardians
 * set the transaction status to confirm or fail
 */
async function init() {
  console.log("starting cron-job");

  // the database operation is atomic
  // according to mongo, only write operations will lock the associated document
  // https://www.mongodb.com/community/forums/t/understanding-locking-within-transactions-and-how-it-deals-with-high-concurrency/189518
  await connectDB();

  // [relay] every 30s for scanning [-2h, now)
  const relayRedeemWithin2hJob = new CronJob("*/30 * * * * *", async () => {
    let date = new Date();
    date.setHours(date.getHours() - 2);
    try {
      await checkRedeemed({ arbiterFee: { $gt: "0" }, created: { $gte: date } });
    } catch (e) {
      console.error(e);
    }
  });

  // [relay] every 10 mins for scanning [-24h, -2h)
  const relayRedeemWithin24hJob = new CronJob("0 */10 * * * *", async () => {
    let start = new Date();
    start.setHours(start.getHours() - 12);
    let end = new Date();
    end.setHours(end.getHours() - 2);
    try {
      await checkRedeemed({ arbiterFee: { $gt: "0" }, created: { $gte: start, $lt: end } });
    } catch (e) {
      console.error(e);
    }
  });

  // [relay] every days for scanning [-7d, -1d)
  const relayRedeemWithin7dJob = new CronJob("0 0 * * * *", () => {
    let start = new Date();
    start.setDate(start.getDate() - 7);
    let end = new Date();
    end.setHours(end.getDate() - 1);
    try {
      checkRedeemed({ arbiterFee: { $gt: "0" }, created: { $gte: start, $lt: end } });
    } catch (e) {
      console.error(e);
    }
  });

  // [manually] every days
  const manaullyRedeemJob = new CronJob("0 0 0 * * *", () => {
    try {
      checkRedeemed({ arbiterFee: "0" });
    } catch (e) {
      console.error(e);
    }
  });

  // [index for xswap] daily
  // const xswapJob = new CronJob(
  //   "@daily",
  //   async () => {
  //     try {
  //       await processXswap([
  //         { chain: CHAIN_ID_ETH, dex: "uniswap_v2" },
  //         { chain: CHAIN_ID_ETH, dex: "uniswap_v3" },
  //         { chain: CHAIN_ID_POLYGON, dex: "quickswap" },
  //       ]);
  //     } catch (e) {
  //       console.error(e);
  //     }
  //   },
  //   null,
  //   true,
  // );

  // the database operation is atomic
  // according to mongo, only write operations will lock the associated document
  // https://www.mongodb.com/community/forums/t/understanding-locking-within-transactions-and-how-it-deals-with-high-concurrency/189518
  const solanaCronJob = new CronJob("* * * * *", async () => {
    try {
      await syncSolana();
    } catch (e) {
      console.error(e);
    }
  });

  relayRedeemWithin2hJob.start();
  relayRedeemWithin24hJob.start();
  relayRedeemWithin7dJob.start();
  manaullyRedeemJob.start();
  solanaCronJob.start();

  startEVMIndexer();
  fetchVAAs();
}

init();

const port = process.env.PORT ?? 27002;
const app = express();

app.use(express.json());

app.get("/metrics", [getMetrics]);

const server = app.listen(port, function () {
  console.log(`cron-job metrics - REST API server listening at ${port}`);
});
