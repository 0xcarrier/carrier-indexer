import { ethers } from "ethers";
import { connectDB } from "../database/connection";
import { ITxn, TransactionModel } from "../database/txnModel";
import { IToken, TokenModel } from "../database/tokenModel";

const txnPerRounds = 10000;

async function aggregateAndremoveDupTransactions(offset = 0) {
  const result = await TransactionModel.aggregate([
    { $skip: offset },
    { $limit: txnPerRounds },
    {
      $group: {
        _id: { sourceChainId: "$sourceChainId", txn: "$txn", destChainId: "$destChainId" },
        count: { $sum: 1 },
        id: { $push: "$$ROOT._id" },
      },
    },
    { $sort: { createdAt: 1 } },
    {
      $match: {
        count: { $gte: 2 },
      },
    },
  ]);

  const pendingRemoveIds = result
    .map((item) => {
      return item.id.map((item: any, index: number) => {
        if (index !== 0) {
          return item.toString();
        }
      });
    })
    .flat()
    .filter((item) => item != null);

  await TransactionModel.deleteMany({ _id: { $in: pendingRemoveIds } });

  console.log("pendingRemoveIds", pendingRemoveIds);

  const count = await TransactionModel.count();
  const nextOffset = offset + txnPerRounds - pendingRemoveIds.length;

  console.log("nextOffset", nextOffset, count);

  if (nextOffset < count - 1) {
    console.log("next call", nextOffset, count);
    await aggregateAndremoveDupTransactions(nextOffset);
  }
}

async function aggregateAndremoveDupTokens(offset = 0) {
  const result = await TokenModel.aggregate([
    { $skip: offset },
    { $limit: txnPerRounds },
    {
      $group: {
        _id: { chainId: "$chainId", tokenAddress: "$tokenAddress" },
        count: { $sum: 1 },
        id: { $push: "$$ROOT._id" },
      },
    },
    { $sort: { createdAt: 1 } },
    {
      $match: {
        count: { $gte: 2 },
      },
    },
  ]);

  const pendingRemoveIds = result
    .map((item) => {
      return item.id.map((item: any, index: number) => {
        if (index !== 0) {
          return item.toString();
        }
      });
    })
    .flat()
    .filter((item) => item != null);

  await TokenModel.deleteMany({ _id: { $in: pendingRemoveIds } });

  console.log("pendingRemoveIds", pendingRemoveIds);

  const count = await TokenModel.count();
  const nextOffset = offset + txnPerRounds - pendingRemoveIds.length;

  console.log("nextOffset", nextOffset, count);

  if (nextOffset < count - 1) {
    console.log("next call", nextOffset, count);
    await aggregateAndremoveDupTokens(nextOffset);
  }
}

export async function removeDups() {
  await connectDB();

  await aggregateAndremoveDupTransactions();
  await aggregateAndremoveDupTokens();

  // await testInsertDupTxOnTestnet();
  // await testInsertDupTxOnMainnet();
  // await testInsertDupTokenOnMainnet();
  // await testInsertDupTokenOnTestnet();
}

async function testInsertDupTxOnMainnet() {
  const txn = {
    txn: "0x26d5c138859eb3dd6380ecf4985b99aa78ce9dba7bdd22be499154e82501c2ce",
    arbiterFee: "0",
    created: new Date(),
    destChainId: 2,
    emitterAddress: "0x796dff6d74f3e27060b71255fe517bfb23c93eed",
    isSourceNative: false,
    recipient: "0xca9c8d118c0b3b8b2a0470e8476a661d59b1dd19",
    sender: "0xca9c8d118c0b3b8b2a0470e8476a661d59b1dd19",
    sourceChainId: 14,
    sourceTokenAddress: "0x37f750b7cc259a2f741af45294f6a16572cf5cad",
    status: "redeemed",
    tokenAmt: "20000000000",
    txnType: "token_bridge",
    unwrappedSourceChainId: 2,
    unwrappedSourceTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    updated: new Date(),
    wormholeSequence: "2762",
    signedVAABytes:
      "AQAAAAMNALDjzml18gY3uRr8SPSA/jhUj9WlD9cov41BfScqtA2NIjgGyr0ilEjC6yGoeajX1YnRShWQALiRDxPvxle62PAAAueoFpu8dSfDy+SZOPs0tddDu1yPPj/aCodfsg9iVbMMHRDZRzDQYRTfecMwQ8fMNBxCGnHI7IhTGLNRBI0ElE4BA5yFHcj+B4p9HklT+AprzXBpUKvUWiXQ/GaN7PyLNX3lPMjnYscpMn5AVZB2AcSSq0lUmJ++MP/gqFNBU+KmWZQABqBnDRsiOGjNZBp7lieC2PVZ6FJkDsjrCv690q1j6AwDDfzVKMBJWYceSSVuVx7Ik8BdQTpgMKmaSv74XDNKLyQAB7HShIi8r2/CJMgD+I7Zy/rUhBi666Q+Dxj8UV7Nu+bDL9No3RfslfBH6MmaeNk85CmV3LXhEIDLAPReRSAO9vUBCUF/YCfeQhi1EDy67FcsVWtdDIP+hW5F91cn+DT5bBqRI5ugFd6F6+r9ifGBgmwHO+/GOAGBLHlBQg4347qv7IoACna3PJsCHrwlXy2fpcFchR6Khy3q68qgvZpFkNMz6bRdPl4K63FrC9rgjrlchEcLt9ywzqESNNVeBUf6+RgFckYBCyddrhDENPZqNctHkLtBPskncdSoS2oc/lt+V6blc+l7ENhr4dAsJXXnsXq383fdo0DbRbrqaB7eBszTIylEeHsADOa1cdYcFpIav9G0MiNJFovHNh0z4YjQ21Wg14pl72spRFXBIwCLpziyy7axT/9nl+FYEeRZ1g0g4swvWm67SCEADRIokEMa3S8Fhg/zn2PWl37eyCR4eXvtk2ZDbHz1bLhcfx3jU6HVNfWslAP1MvzRD7wdreoSlNvuI7RY1vxycMEAD4u6WW28L53frZ2olBBL7+xOPsCjoPRylCB0k5doJWWBTVUzuurPz9PNV5h/HXug1g9X5mqaIuL/4lLWIZ9fRjQAECiRKvm6kF9JdXyN89yVXVJEU75sStAqo8bipsN+sRpsQcHlE2Z2/V9MTYyjZumv+ebYbUfZWHOUZjWbE+jDENIAEufOtjETOw3GtOMn2rQeck1Gk8dcXjijfI+HdphCrgGyAFzWKTVFKu8qVm+LyjZ45di3CoDRm3zR62WcWXqf4s0AY+nP+ltYAQAADgAAAAAAAAAAAAAAAHlt/2108+JwYLcSVf5Re/sjyT7tAAAAAAAACsoBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASoF8gAAAAAAAAAAAAAAAAAoLhpkcYhizbB0Z1KLp6wzjYG60gAAgAAAAAAAAAAAAAAAMqcjRGMCzuLKgRw6EdqZh1Zsd0ZAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    redeemTxn: "0x2552bdca9989cd86560ad9eb8b1609512792d599a7ed1d6477bf6d67db692f76",
    signedVAAHash: "0x7c490763b1b0102e5a0785ac871689de87bda70a0dd21095e49e8a9b022f7e69",
    destTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  };

  await testInsertDupTx(txn);
}

async function testInsertDupTxOnTestnet() {
  const txn = {
    txn: "0xff382673f74804d892b02ea5a80755f7deab690dd60853631f5ef7dd087d8aab",
    arbiterFee: "0",
    created: new Date(),
    destChainId: 4,
    emitterAddress: "0xf890982f9310df57d00f659cf4fd87e65aded8d7",
    isSourceNative: false,
    recipient: "0x0000000000000000000000000000000000000000",
    sender: "0xdb1e4e1b61b8c2454f88c773a6ad52bd9c94efaf",
    sourceChainId: 2,
    sourceTokenAddress: "0x0000000000000000000000000000000000000000",
    status: "confirmed",
    tokenAmt: "1842729580",
    txnType: "token_bridge",
    unwrappedSourceChainId: 2,
    unwrappedSourceTokenAddress: "0x811592636ef5428b6159edefc3be641c05e84f70",
    updated: new Date(),
    wormholeSequence: "3001",
    signedVAABytes:
      "AQAAAAABAFuYSuugtqfrtbmYGB0WtROBQaBNMeRM5EYdApJlG+W6HKoYBGwRPJNGM3O0JdNRTALsRRTGUHUzw/Hij6TxmTYAY5viqAAAADMAAgAAAAAAAAAAAAAAAPiQmC+TEN9X0A9lnPT9h+Za3tjXAAAAAAAAC7kBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABt1dJsAAAAAAAAAAAAAAAAgRWSY271QothWe3vw75kHAXoT3AAAgAAAAAAAAAAAAAAAPx0YljeMSV6th+/O4PkwuxunRAlAAQAAAAAAAAAAAAAAAA343xIwNGaCJqqrueEvsyMucJQ5wAAAAAAAAAAAAAAANseThthuMJFT4jHc6atUr2clO+v",
    signedVAAHash: "0xbfd9ee892a72b8605d0fdca9f6a4f6ef29b6507e4ca74db26efa581dd31733b5",
    destTokenAddress: "0x5d1fe1fadc4ed6de32538c12cfa6841cd61892f3",
  };

  await testInsertDupTx(txn);
}

async function testInsertDupTx(txn: ITxn) {
  const randomTxn = ethers.utils.hexZeroPad(ethers.utils.hexlify(Date.now()), 32);
  const txn2 = {
    ...txn,
    txn: randomTxn,
  } as ITxn;

  console.log("randomTxn", randomTxn);

  const records = [txn, txn, txn2];

  try {
    const result = await TransactionModel.insertMany(records, { ordered: false });

    console.log("result", result);
  } catch (e: any) {
    if (e.code === 11000) {
      const successHashes = e.insertedDocs.map((item: ITxn) => item.txn);
      const failedHashes = records.filter((item) => !successHashes.includes(item.txn)).map((item) => item.txn);
      console.log(
        `partial record inserted. success: ${e.result.result.nInserted}, failed: ${
          e.result.result.writeErrors.length
        }. success hashes: ${successHashes.join(",")}, failed hashes: ${failedHashes.join(",")}`,
      );
    }
  }
}

async function testInsertDupTokenOnMainnet() {
  const token = {
    chainId: 2,
    tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    created: new Date(),
    name: "Tether USD",
    symbol: "USDT",
    updated: new Date(),
    decimals: 6,
  };

  await testInsertDupToken(token);
}

async function testInsertDupTokenOnTestnet() {
  const token = {
    tokenAddress: "0x9d2fc26eaed3ca793d7f99df7fd4d21cdbe7897d",
    created: new Date(),
    decimals: 18,
    name: "TestToken",
    symbol: "TT",
    updated: new Date(),
    chainId: 5,
  };

  await testInsertDupToken(token);
}

async function testInsertDupToken(txn: IToken) {
  const randomAddress = ethers.utils.hexZeroPad(ethers.utils.hexlify(Date.now()), 20);
  const txn2 = {
    ...txn,
    tokenAddress: randomAddress,
  } as IToken;

  console.log("randomAddress", randomAddress);

  const records = [txn, txn, txn2];

  try {
    const result = await TokenModel.insertMany(records, { ordered: false });

    console.log("result", result);
  } catch (e: any) {
    if (e.code === 11000) {
      const successAddresses = e.insertedDocs.map((item: IToken) => item.tokenAddress);
      const failedAddresses = records
        .filter((item) => !successAddresses.includes(item.tokenAddress))
        .map((item) => item.tokenAddress);
      console.log(
        `partial record inserted. success: ${e.result.result.nInserted}, failed: ${
          e.result.result.writeErrors.length
        }. success addresses: ${successAddresses.join(",")}, failed addresses: ${failedAddresses.join(",")}`,
      );
    }
  }
}
