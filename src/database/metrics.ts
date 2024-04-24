import { MongooseDocumentMiddleware, MongooseQueryMiddleware, Schema } from "mongoose";
import {
  dbQueryCountMonitor,
  dbQueryErrorMonitor,
  dbUpdateCountMonitor,
  dbUpdateErrorMonitor,
} from "../utils/prometheus";

export function addDBMetrics<TSchema extends Schema = any>(options: { schema: TSchema; model: string }) {
  const { schema, model } = options;

  function updateCountMonitor() {
    dbUpdateCountMonitor.labels(model).inc();
  }

  function updateErrorMonitor(error: any) {
    if (error && error.name && error.code) {
      dbUpdateErrorMonitor.labels(model).inc();
    }
  }

  function queryCountMonitor() {
    dbQueryCountMonitor.labels(model).inc();
  }

  function queryErrorMonitor(error: any) {
    if (error && error.name && error.code) {
      dbQueryErrorMonitor.labels(model).inc();
    }
  }

  const updateMethods: string[] = [
    "save",
    "init",
    "deleteMany",
    "deleteOne",
    "remove",
    "replaceOne",
    "update",
    "updateOne",
    "updateMany",
    "insertMany",
  ];

  updateMethods.map((method) => {
    schema.pre(method as MongooseDocumentMiddleware, updateCountMonitor);
    schema.post(method as MongooseDocumentMiddleware, updateErrorMonitor);
  });

  const queryMethods: string[] = [
    "count",
    "countDocuments",
    "estimatedDocumentCount",
    "find",
    "findOne",
    "findOneAndDelete",
    "findOneAndRemove",
    "findOneAndReplace",
    "findOneAndUpdate",
    "validate",
    "aggregate",
  ];

  queryMethods.map((method) => {
    schema.pre(method as MongooseQueryMiddleware, queryCountMonitor);
    schema.post(method as MongooseQueryMiddleware, queryErrorMonitor);
  });
}
