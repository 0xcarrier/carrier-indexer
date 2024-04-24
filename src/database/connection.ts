import mongoose from "mongoose";
import process from "process";

function handleError(err: Error) {
  console.log(`Connection error ${err}`);
}

export async function connectDB() {
  if (mongoose.connection.readyState === mongoose.ConnectionStates.connected) {
    return mongoose.connection;
  }

  try {
    const atlasUri =
      process.env.CLUSTER === "mainnet" ? process.env.MONGODB_MAINNET_ATLAS_URI : process.env.MONGODB_TESTNET_ATLAS_URI;

    if (!atlasUri) {
      throw new Error("atlasUri is empty");
    }

    // console.log("mongodb address:", atlasUri);

    mongoose.connection.on("error", handleError);

    mongoose.connection.once("open", () => {
      console.log("MongoDB database connection established successfully");
    });

    await mongoose.connect(atlasUri);

    process.on("exit", () => {
      disconnectDB();
    });

    return mongoose.connection;
  } catch (e) {
    console.log("could not connect to database ", e);
  }
}

export async function disconnectDB() {
  mongoose.connection.off("error", handleError);

  if (
    mongoose.connection.readyState === mongoose.ConnectionStates.connected ||
    mongoose.connection.readyState === mongoose.ConnectionStates.connecting
  ) {
    await mongoose.disconnect();
  }
}
