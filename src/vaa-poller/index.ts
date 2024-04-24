import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

import { connectDB } from "../database/connection";
import { fetchVAAs } from "./poll-vaa";
import express from "express";
import { getMetrics } from "../server/controller";

/**
 * grab the list of pending transactions
 * poll vaa from wormhole guardians
 * set the transaction status to confirm or fail
 */
async function init() {
  console.log("starting vaa poller");

  // the database operation is atomic
  // according to mongo, only write operations will lock the associated document
  // https://www.mongodb.com/community/forums/t/understanding-locking-within-transactions-and-how-it-deals-with-high-concurrency/189518
  await connectDB();

  fetchVAAs();
}

init();

const port = process.env.PORT ?? 27005;
const app = express();

app.use(express.json());

app.get("/metrics", [getMetrics]);

const server = app.listen(port, function () {
  console.log(`vaa poller metrics - REST API server listening at ${port}`);
});
