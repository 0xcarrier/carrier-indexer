import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

import express from "express";
import { getClusterName } from "../bridge";
import { connectDB } from "../database/connection";
import { routesConfig } from "./routes.config";

const port = process.env.PORT ?? 27001;
const app = express();

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE");
  res.header("Access-Control-Expose-Headers", "Content-Length");
  res.header("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Requested-With, Range");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  } else {
    return next();
  }
});

async function init() {
  // connect to database
  await connectDB();

  app.use(express.json());

  await routesConfig(app);

  /**
   * REST api server
   * allow users to query for transaction history
   */
  const server = app.listen(port, function () {
    const cluster = getClusterName();
    console.log(`${cluster} - REST API server listening at ${port}`);
  });
  return server;
}

init();
