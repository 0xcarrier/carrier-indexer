import { TokenModel } from "../database/tokenModel";
import { ITxn, TransactionModel } from "../database/txnModel";
import { IToken } from "../database/tokenModel";
import { TXN_TYPE } from "../utils/constants";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  apiCountMonitorByTransactions,
  apiCountMonitorByWalletTransactions,
  apiCountMonitorByXswap,
  apiLatencyMonitorByTransactions,
  apiLatencyMonitorByWalletTransactions,
  apiLatencyMonitorByXswap,
} from "../utils/prometheus";
import promClient from "prom-client";
import { ManualIndexedTransactionStatus, ManualIndexedTransactions } from "../database/manualIndexedTransactionModel";
import { constructSolanaConnection } from "../utils/solana";
import { CHAIN_ID_SOLANA } from "../utils/wormhole";

interface PaginateResult {
  counts: number;
  limit: number;
  current: number;
  pages: number;
  previous: number | null;
  next: number | null;
  transactions: ITxn[];
  redeemTransactions: ITxn[];
  tokens: IToken[];
}
/**
 * create a search filter array from req.query
 * @param filters req.query input by users
 * @param fieldsList list of fields we want to let users search by
 * array in the form
 * [ { db_field1: 'user_query', db_field2: 'user_query' } ]
 */
const getSearchFilter = (filters: any, fieldsList: any) => {
  const searchFilter: any[] = [];
  for (const fieldName of fieldsList) {
    if (!filters.hasOwnProperty(fieldName)) {
      continue;
    }
    let filter: any = {};
    let keyword = filters[fieldName];
    if (fieldName === "sender" || fieldName === "recipient") {
      // lower case address
      keyword = keyword.toLowerCase();
    }
    filter[fieldName] = keyword;
    searchFilter.push(filter);
  }
  return searchFilter;
};

interface PaginateQuery {
  page: string | null;
  limit: string | null;
  startTxn: string | null;
}

interface TransactionQuery {
  sender: string | null;
  recipient: string | null;
  user: string | null; // sender or recipient
  txn: string | null;
  chainId: number | null; // sourceChainId or destChainId
  sourceChainId: number | null;
  destChainId: number | null;
  status: string | null;
  type: string | null;
}

interface Query {
  required: TransactionQuery | null;
  optional: TransactionQuery | null;
}

const toMongoFilter = (query: Query) => {
  let filters: any = {};
  if (query.required) {
    let and = toTxnFilter(query.required);
    if (and.length > 0) {
      filters["$and"] = and;
    }
  }
  if (query.optional) {
    let or = toTxnFilter(query.optional);
    if (or.length > 0) {
      filters["$or"] = or;
    }
  }
  return filters;
};

const toTransactionQuery = (query: any, fieldsList: any) => {
  let txnQuery: any = {};
  fieldsList.map((field: string) => {
    txnQuery[field] = query[field];
  });
  return txnQuery as TransactionQuery;
};

const userNomalize = (user: string) => {
  if (user.startsWith("0x")) {
    return user.toLowerCase();
  }
  return user;
};

const toTxnFilter = (txnQuery: TransactionQuery) => {
  let filters: any[] = [];
  if (txnQuery.sender) {
    let senders = txnQuery.sender.split(",");
    senders = senders.map(userNomalize);
    if (senders.length > 0) {
      filters.push({ sender: { $in: senders } });
    }
  }
  if (txnQuery.recipient) {
    let recipients = txnQuery.recipient.split(",");
    recipients = recipients.map(userNomalize);
    if (recipients.length > 0) {
      filters.push({ recipient: { $in: recipients } });
    }
  }
  if (txnQuery.user) {
    let users = txnQuery.user.split(",");
    users = users.map(userNomalize);
    if (users.length > 0) {
      filters.push({ $or: [{ recipient: { $in: users } }, { sender: { $in: users } }] });
    }
  }
  if (txnQuery.txn) {
    filters.push({ txn: txnQuery.txn });
  }
  if (txnQuery.chainId) {
    filters.push({ $or: [{ sourceChainId: txnQuery.chainId }, { destChainId: txnQuery.chainId }] });
  }
  if (txnQuery.sourceChainId) {
    filters.push({ sourceChainId: txnQuery.sourceChainId });
  }
  if (txnQuery.destChainId) {
    filters.push({ destChainId: txnQuery.destChainId });
  }
  if (txnQuery.status) {
    filters.push({ status: txnQuery.status });
  }
  if (txnQuery.type) {
    let types = txnQuery.type.split(",").map((ty: string) => {
      switch (ty) {
        case "nft":
          return TXN_TYPE.NFT_BRIDGE;
        case "token":
          return TXN_TYPE.TOKEN_BRIDGE;
        case "redeem":
          return TXN_TYPE.REDEEM;
        case "swap":
          return TXN_TYPE.SWAP;
        default:
          return ty;
      }
    });
    if (types.length > 0) {
      filters.push({ txnType: { $in: types } });
    }
  }
  return filters;
};

const rendenTransactions = async (res: any, query: Query, paginate: PaginateQuery) => {
  let filter = toMongoFilter(query);
  // console.log("filter: ", JSON.stringify(filter));

  // paginate value is a string
  let _page = paginate.page ? parseInt(`${paginate.page}`) : 0;
  let _limit = paginate.limit ? parseInt(`${paginate.limit}`) : 10;

  try {
    const page = paginate.page || 0;
    const limit = paginate.limit || 10;
    const paginateResult: PaginateResult = {
      counts: 0, // total number documents returned
      limit: _limit, // number of documents per page
      current: _page, // current page
      pages: 0, // total number of pages
      previous: null, // track if there is a previous
      next: null, // track if there is a next
      transactions: [],
      redeemTransactions: [],
      tokens: [],
    };

    let counts = await TransactionModel.countDocuments(filter).read("nearest");

    let startIndex = _page * _limit;
    const endIndex = (_page + 1) * _limit;

    if (startIndex > 0) {
      paginateResult.previous = _page - 1;
    }

    if (endIndex < counts) {
      paginateResult.next = _page + 1;
    }

    const hard_item_limit: number = 500;

    if (+limit > 100 || startIndex + +limit > hard_item_limit) {
      return res.status(500).json({ msg: "too many pages" });
    }
    if (counts > hard_item_limit) {
      counts = hard_item_limit;
    }

    paginateResult.counts = counts;
    paginateResult.limit = _limit;
    paginateResult.pages = Math.ceil(counts / _limit);

    const result = await TransactionModel.find(filter, { _id: 0, __v: 0 })
      .read("nearest")
      .sort("-_id")
      .skip(startIndex)
      .limit(_limit);

    paginateResult.transactions = result;

    const redeemTransactionHashes = result.map((item) => item.redeemTxn).filter((item) => !!item);
    const redeemTransactions = await TransactionModel.find({
      txn: { $in: redeemTransactionHashes },
      txnType: TXN_TYPE.REDEEM,
    })
      .read("nearest")
      .sort("-_id");

    paginateResult.redeemTransactions = redeemTransactions;

    let tokenFilterArray: any = [];
    let tokensFilter: any = {};

    for (const transaction of result) {
      if (transaction.sourceTokenAddress && transaction.sourceChainId) {
        tokenFilterArray.push({ tokenAddress: transaction.sourceTokenAddress, chainId: transaction.sourceChainId });
      }
      if (transaction.destTokenAddress && transaction.destChainId) {
        tokenFilterArray.push({ tokenAddress: transaction.destTokenAddress, chainId: transaction.destChainId });
      }
    }

    for (const redeemTransaction of redeemTransactions) {
      if (redeemTransaction.destTokenAddress && redeemTransaction.destChainId) {
        tokenFilterArray.push({
          tokenAddress: redeemTransaction.destTokenAddress,
          chainId: redeemTransaction.destChainId,
        });
      }
    }

    let tokens: IToken[] = [];

    if (tokenFilterArray.length > 0) {
      tokensFilter["$or"] = tokenFilterArray;
      tokens = await TokenModel.find(tokensFilter, { _id: 0, __v: 0 }).read("nearest").sort("-_id");
    }

    paginateResult.tokens = tokens;

    return res.status(200).json({
      msg: "success",
      results: paginateResult,
    });
  } catch (e) {
    console.log(e);
    return res.status(500).json({ msg: "sorry, something went wrong" });
  }
};

/**
 * get transactions belong to a specific wallet by chain
 * @param req
 * @param res
 * @returns
 */
export const getWalletTransactionsByChain = async (req: any, res: any) => {
  if (!req.params || !req.params.chainId || !req.params.wallet) {
    return res.status(200).json({
      msg: "success",
      results: {},
    });
  }

  apiCountMonitorByWalletTransactions.labels({ chainId: req.params.chainId, wallet: req.params.wallet }).inc();
  const endTimer = apiLatencyMonitorByWalletTransactions.startTimer({
    chainId: req.params.chainId,
    wallet: req.params.wallet,
  });

  try {
    const chainId = parseInt(req.params.chainId);
    let wallets = [req.params.wallet];

    if (chainId === CHAIN_ID_SOLANA) {
      // for solana, the recipient should be the associated token accounts
      const connection = constructSolanaConnection("confirmed");
      // TODO: what if get token accounts too much?
      const tokenAccounts = await connection.getTokenAccountsByOwner(new PublicKey(req.params.wallet), {
        programId: TOKEN_PROGRAM_ID,
      });
      for (const accountData of tokenAccounts.value) {
        wallets.push(accountData.pubkey.toString());
      }
    }

    let query: Query = {
      required: {
        chainId: chainId,
        user: wallets.join(","),
        type: [TXN_TYPE.NFT_BRIDGE, TXN_TYPE.TOKEN_BRIDGE, TXN_TYPE.SWAP].join(","),
      } as TransactionQuery,
      optional: toTransactionQuery(req.query, ["txn", "sender", "recipient"]),
    };
    return rendenTransactions(res, query, req.query as PaginateQuery);
  } catch (e) {
    console.log(e);
    return res.status(500).json({ msg: "sorry, something went wrong" });
  } finally {
    endTimer();
  }
};

/**
 * get a list of transactions filtered by params
 * INCLUDES nft bridge, token bridge, swap, redeem
 *
 * if no params are given, returns ALL the transaction
 * if no result found, returns an empty array
 *
 * e.g. /api/v1/transactions/?txn=0x1234567
 *
 * supports pagination
 * /api/v1/transactions/?page=0
 *
 * == FILTERS ==
 * query for a certain page   ?page=0, default
 * limit entries by page      ?limit=10, default
 * filter by sender:          ?sender=<address>
 * filter by list of sender:  ?sender=<address1>,<address2>,<addressK>
 * filter by recipient:       same as sender
 * filter by type:            ?type=nft / ?type=token / ?type=redeem / ?type=swap
 * filter by list of type:    ?type=nft,token
 * filter by txn:             ?txn=<hash>
 *
 * ---- not supported currently for safe -------
 * filter by sourceChainId:   ?sourceChainId=2
 * filter by destChainId:     ?destChainId=2
 * filter by status:          ?status=pending / ?status=failed / ?status=confirmed / ?status=redeemed
 *
 * @param req params: txn, sender, recipient, sourceChainId, destChainId, status, type
 * @param res
 */
export const getAllTransactions = async (req: any, res: any) => {
  apiCountMonitorByTransactions.inc();
  const endTimer = apiLatencyMonitorByTransactions.startTimer();

  try {
    let requiredQuery = toTransactionQuery(req.query, ["type"]);
    if (!requiredQuery.type) {
      requiredQuery.type = [TXN_TYPE.NFT_BRIDGE, TXN_TYPE.TOKEN_BRIDGE, TXN_TYPE.SWAP].join(",");
    }
    // add solana tokenAccounts?
    let query: Query = {
      required: requiredQuery,
      optional: toTransactionQuery(req.query, ["sender", "recipient", "txn"]),
    };

    return rendenTransactions(res, query, req.query as PaginateQuery);
  } catch (e) {
    console.log(e);
    return res.status(500).json({ msg: "sorry, something went wrong" });
  } finally {
    endTimer();
  }
};

export const syncTransaction = async (req: any, res: any) => {
  try {
    const { type, hash, chainId } = req.body;

    const existedTransaction = await ManualIndexedTransactions.findOne({ type, chainId, hash: hash.toLowerCase() });
    const now = new Date();

    if (existedTransaction) {
      return res.status(400).json({ msg: `record already exists, status: ${existedTransaction.status}` });
    } else {
      const newRecord = new ManualIndexedTransactions({
        type,
        chainId,
        hash: hash.toLowerCase(),
        status: ManualIndexedTransactionStatus.Pending,
        created: now,
        updated: now,
      });

      await newRecord.save();

      return res.status(200).json({ msg: `record create successfully` });
    }
  } catch (e) {
    console.log(e);
    return res.status(500).json({ msg: "sorry, something went wrong" });
  }
};

export async function getMetrics(req: any, res: any) {
  try {
    const metrics = await promClient.register.metrics();

    res.send(metrics);
  } catch (e) {
    console.log(e);
    return res.status(500).json({ msg: "sorry, something went wrong" });
  }
}
