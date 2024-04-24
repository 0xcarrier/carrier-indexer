import { connectDB } from "../database/connection";
import { TransactionModel } from "../database/txnModel";
import { TXN_STATUS } from "../utils/constants";

async function updateTxnsStatus() {
  const result = await TransactionModel.updateMany(
    {
      $and: [{ status: TXN_STATUS.FAILED }, { created: { $gte: new Date("2023-12-15T00:00:00.000+00:00") } }],
    },
    { status: TXN_STATUS.PENDING },
  );

  console.log("result", result);
}

export async function updateStatus() {
  await connectDB();

  await updateTxnsStatus();
}
