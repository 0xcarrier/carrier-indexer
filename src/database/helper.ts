import { ITxn, TransactionModel } from "./txnModel";
import { IToken, TokenModel } from "./tokenModel";

export async function addTransactionToDB(transaction: ITxn) {
  const exists = await TransactionModel.exists({ txn: transaction.txn });

  if (exists) {
    console.warn(`transaction exists: ${transaction.txn}`);
  } else {
    await new TransactionModel(transaction).save();
    console.log(`transaction added to db: ${transaction.txn}`);
  }
}

export async function addTransactionsToDB(transactions: ITxn[]) {
  if (transactions.length > 0) {
    try {
      await TransactionModel.insertMany(transactions, { ordered: false });
      console.log(`transactions inserted. ${transactions.map((item) => item.txn).join(",")}`);
    } catch (e: any) {
      const successHashes = e.insertedDocs.map((item: ITxn) => item.txn);
      const failedHashes = transactions.filter((item) => !successHashes.includes(item.txn)).map((item) => item.txn);
      console.warn(
        `partial transactions inserted. success: ${e.result.result.nInserted}, dup: ${
          e.result.result.writeErrors.length
        }. success hashes: ${successHashes.join(",")}, dup hashes: ${failedHashes.join(",")}`,
      );
    }
  }
}

export async function addTokensToDB(tokens: IToken[]) {
  if (tokens.length > 0) {
    try {
      await TokenModel.insertMany(tokens);
      console.log(`token inserted. ${tokens.map((item) => `${item.chainId}:${item.tokenAddress}`).join(",")}`);
    } catch (e: any) {
      const successTokens = e.insertedDocs.map((item: IToken) => item.tokenAddress);
      const failedTokens = tokens
        .filter((item) => !successTokens.includes(item.tokenAddress))
        .map((item) => item.tokenAddress);
      console.warn(
        `partial tokens inserted. success: ${e.result.result.nInserted}, dup: ${
          e.result.result.writeErrors.length
        }. success tokens: ${successTokens.join(",")}, dup tokens: ${failedTokens.join(",")}`,
      );
    }
  }
}
