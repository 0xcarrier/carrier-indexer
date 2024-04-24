import promClient from "prom-client";

export const apiCountMonitorByTransactions = new promClient.Counter({
  name: "API_TRANSACTIONS_COUNT",
  help: "API_TRANSACTIONS_COUNT",
});

export const apiCountMonitorByWalletTransactions = new promClient.Counter({
  name: "API_TRANSACTIONS_BY_WALLET_COUNT",
  help: "API_TRANSACTIONS_BY_WALLET_COUNT",
  labelNames: ["chainId", "wallet"],
});

export const apiCountMonitorByXswap = new promClient.Counter({
  name: "API_XSWAP_COUNT",
  help: "API_XSWAP_COUNT",
});

export const apiLatencyMonitorByTransactions = new promClient.Histogram({
  name: "API_TRANSACTIONS_LATENCY",
  help: "API_TRANSACTIONS_LATENCY",
});

export const apiLatencyMonitorByWalletTransactions = new promClient.Histogram({
  name: "API_TRANSACTIONS_BY_WALLET_LATENCY",
  help: "API_TRANSACTIONS_BY_WALLET_LATENCY",
  labelNames: ["chainId", "wallet"],
});

export const apiLatencyMonitorByXswap = new promClient.Histogram({
  name: "API_XSWAP_LATENCY",
  help: "API_XSWAP_LATENCY",
});

export const providerCountMonitor = new promClient.Counter({
  name: `PROVIDER_COUNT`,
  help: `PROVIDER_COUNT`,
  labelNames: ["chainId", "method"],
});

export const providerLatencyMonitor = new promClient.Histogram({
  name: `PROVIDER_LATENCY`,
  help: `PROVIDER_LATENCY`,
  labelNames: ["chainId", "method"],
});

export const providerErrorCountMonitor = new promClient.Counter({
  name: `PROVIDER_ERROR_COUNT`,
  help: `PROVIDER_ERROR_COUNT`,
  labelNames: ["chainId", "method"],
});

export const dbQueryCountMonitor = new promClient.Counter({
  name: "DB_QUERY_COUNT",
  help: "DB_QUERY_COUNT",
  labelNames: ["model"],
});

export const dbQueryErrorMonitor = new promClient.Counter({
  name: "DB_QUERY_ERROR",
  help: "DB_QUERY_ERROR",
  labelNames: ["model"],
});

export const dbUpdateCountMonitor = new promClient.Counter({
  name: "DB_UPDATE_COUNT",
  help: "DB_UPDATE_COUNT",
  labelNames: ["model"],
});

export const dbUpdateErrorMonitor = new promClient.Counter({
  name: "DB_UPDATE_ERROR",
  help: "DB_UPDATE_ERROR",
  labelNames: ["model"],
});
