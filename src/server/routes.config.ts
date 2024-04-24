import { getWalletTransactionsByChain, getAllTransactions, getMetrics, syncTransaction } from "./controller";
import { Express } from "express";

export async function routesConfig(app: Express) {
  app.get("/api/v1/transactions/:chainId/:wallet", [getWalletTransactionsByChain]);
  app.get("/api/v1/transactions", [getAllTransactions]);
  app.post("/api/v1/transactions/sync", [syncTransaction]);

  app.get("/metrics", [getMetrics]);
}
