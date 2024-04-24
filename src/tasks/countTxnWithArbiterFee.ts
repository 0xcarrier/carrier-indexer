import { ethers } from "ethers";
import { connectDB } from "../database/connection";
import { TokenModel } from "../database/tokenModel";
import { TransactionModel } from "../database/txnModel";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_FANTOM,
  CHAIN_ID_KLAYTN,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_OASIS,
  CHAIN_ID_POLYGON,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
  CHAIN_ID_TERRA,
  ChainId,
  toChainName,
} from "../utils/wormhole";
import BigNumber from "bignumber.js";

let unknownTxCount = 0;
const txnPerRounds = 1000;

const chains: {
  [chainId: number]: {
    [tokenAddress: string]: {
      txnCount: number;
      symbol: string;
      decimals: number;
      amount: string;
      amountFormated: string;
      fee: string;
      feeFormated: string;
    };
  };
} = {};

const tokenMap: { [symbol: string]: string } = { MATICPO: "MATIC", USDCET: "USDC", USDTET: "USDT" };

const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";

const computeHumanReadableCurrency = (options: { decimals?: number; amountStr: string; isSolanaBridge: boolean }) => {
  const { decimals, amountStr, isSolanaBridge } = options;
  const denormBN = ethers.FixedNumber.from(amountStr);
  let decShift;
  const tens = ethers.BigNumber.from(10);

  if (isSolanaBridge) {
    // wrapped sol is 9 decimals
    decShift = ethers.FixedNumber.from(tens.pow(9).toString());
  } else if (decimals) {
    // other erc20 tokens
    if (decimals > 8) {
      decShift = ethers.FixedNumber.from(tens.pow(8).toString());
    } else {
      decShift = ethers.FixedNumber.from(tens.pow(decimals).toString());
    }
  } else {
    // no token info; assume it is the standard 18 decimals
    // denormalize wormhole value
    decShift = ethers.FixedNumber.from(tens.pow(8).toString());
  }

  const amount = denormBN.divUnsafe(decShift).toString();

  return amount;
};

async function countTxn(offset = 0) {
  const result = await TransactionModel.find({
    txnType: "token_bridge",
    arbiterFee: { $ne: "0", $exists: true },
  })
    .skip(offset)
    .limit(txnPerRounds);

  for (let record of result) {
    chains[record.destChainId] = chains[record.destChainId] || {};
    const tokenAddressTemp =
      record.sourceTokenAddress && record.sourceTokenAddress !== ethers.constants.AddressZero
        ? record.sourceTokenAddress
        : record.unwrappedSourceChainId === record.sourceChainId
        ? record.unwrappedSourceTokenAddress
        : undefined;
    const tokenAddress =
      tokenAddressTemp && record.sourceChainId !== CHAIN_ID_SOLANA ? tokenAddressTemp.toLowerCase() : tokenAddressTemp;
    const isNativeSolana = record.sourceChainId === CHAIN_ID_SOLANA && record.sourceTokenAddress === WSOL_ADDRESS;

    if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
      unknownTxCount += 1;
      console.log("unknow token record", record);
      continue;
    }

    const token = chains[record.destChainId][tokenAddress];

    if (!token) {
      const tokenInfo = await TokenModel.findOne({ tokenAddress: tokenAddress });
      if (!tokenInfo) {
        unknownTxCount += 1;
        console.log("can't find token modal", record, tokenAddress);
        continue;
      }

      const tokenAmount = computeHumanReadableCurrency({
        decimals: tokenInfo.decimals,
        amountStr: record.tokenAmt,
        isSolanaBridge: isNativeSolana,
      });
      const feeAmount = computeHumanReadableCurrency({
        decimals: tokenInfo.decimals,
        amountStr: record.arbiterFee || "0",
        isSolanaBridge: isNativeSolana,
      });

      chains[record.destChainId][tokenAddress] = {
        txnCount: 1,
        symbol: tokenInfo.symbol || "Unknown symbol",
        decimals: tokenInfo.decimals || 0,
        amount: ethers.utils.parseUnits(tokenAmount, tokenInfo.decimals).toString(),
        amountFormated: tokenAmount,
        fee: ethers.utils.parseUnits(feeAmount, tokenInfo.decimals).toString(),
        feeFormated: feeAmount,
      };
    } else {
      const tokenAmount = computeHumanReadableCurrency({
        decimals: token.decimals,
        amountStr: record.tokenAmt,
        isSolanaBridge: isNativeSolana,
      });
      const tokenAmountParsed = ethers.utils.parseUnits(tokenAmount, token.decimals);
      const feeAmount = computeHumanReadableCurrency({
        decimals: token.decimals,
        amountStr: record.arbiterFee || "0",
        isSolanaBridge: isNativeSolana,
      });
      const feeAmountParsed = ethers.utils.parseUnits(feeAmount, token.decimals);
      const amount = ethers.BigNumber.from(token.amount).add(tokenAmountParsed);
      const fee = ethers.BigNumber.from(token.fee).add(feeAmountParsed);

      chains[record.destChainId][tokenAddress] = {
        txnCount: token.txnCount + 1,
        symbol: token.symbol,
        decimals: token.decimals,
        amount: amount.toString(),
        amountFormated: ethers.utils.formatUnits(amount, token.decimals),
        fee: fee.toString(),
        feeFormated: ethers.utils.formatUnits(fee, token.decimals),
      };
    }
  }

  const nextOffset = offset + txnPerRounds;

  console.log("nextOffset", nextOffset, result.length);

  if (result.length >= txnPerRounds) {
    console.log("next call", nextOffset, result.length);
    await countTxn(nextOffset);
  } else {
    console.log("unknownTxCount", unknownTxCount);
    console.log("final result json", JSON.stringify(chains));
    console.log(
      "final result csv",
      "tokenAddress,destinationChain,symbol,decimals,amount,amountFormated,fee,feeFormated,txnCount\n" +
        Object.keys(chains)
          .map((chainId: any) =>
            Object.keys(chains[chainId]).map((tokenAddress) => {
              const token = chains[chainId][tokenAddress];

              return `${tokenAddress},${toChainName(parseInt(chainId) as ChainId) || chainId},${token.symbol},${
                token.decimals
              },${token.amount},${token.amountFormated},${token.fee},${token.feeFormated},${token.txnCount}\n`;
            }),
          )
          .flat()
          .flat()
          .join(""),
    );

    const aggregatedChain: {
      [chainId: number]: {
        [symbol: string]: {
          txnCount: number;
          symbol: string;
          decimals: number;
          amount: string;
          amountFormated: string;
          fee: string;
          feeFormated: string;
        };
      };
    } = {};

    Object.entries(chains).forEach((chain) => {
      const [chainId, chainValue] = chain;
      const chainIdParsed = parseInt(chainId);

      aggregatedChain[chainIdParsed] = aggregatedChain[chainIdParsed] || {};

      Object.entries(chainValue).forEach((token) => {
        const [tokenAddress, tokenValue] = token;
        const tokenSymbolUnparsed = tokenValue.symbol;
        const tokenSymbol =
          tokenSymbolUnparsed.startsWith("w") || tokenSymbolUnparsed.startsWith("W")
            ? tokenSymbolUnparsed.slice(1)
            : tokenMap[tokenSymbolUnparsed] != null
            ? tokenMap[tokenSymbolUnparsed]
            : tokenSymbolUnparsed;
        const tokenData = aggregatedChain[chainIdParsed][tokenSymbol];

        if (!tokenData) {
          aggregatedChain[chainIdParsed][tokenSymbol] = {
            txnCount: tokenValue.txnCount,
            symbol: tokenSymbol,
            decimals: tokenValue.decimals,
            amount: tokenValue.amount,
            amountFormated: tokenValue.amountFormated,
            fee: tokenValue.fee,
            feeFormated: tokenValue.feeFormated,
          };
        } else {
          if (tokenValue.decimals === tokenData.decimals) {
            const tokenAmountParsed = ethers.BigNumber.from(tokenValue.amount);
            const feeAmountParsed = ethers.BigNumber.from(tokenValue.fee);
            const amount = ethers.BigNumber.from(tokenData.amount).add(tokenAmountParsed);
            const fee = ethers.BigNumber.from(tokenData.fee).add(feeAmountParsed);
            const amountFormated = ethers.utils.formatUnits(amount, tokenData.decimals);
            const feeFormated = ethers.utils.formatUnits(fee, tokenData.decimals);

            aggregatedChain[chainIdParsed][tokenSymbol] = {
              txnCount: tokenValue.txnCount + tokenData.txnCount,
              symbol: tokenData.symbol,
              decimals: tokenData.decimals,
              amount: amount.toString(),
              amountFormated: amountFormated,
              fee: fee.toString(),
              feeFormated: feeFormated,
            };
          } else {
            const tokenAmountFormated = new BigNumber(tokenValue.amountFormated);
            const feeAmountFormated = new BigNumber(tokenValue.feeFormated);
            const amountFormated = new BigNumber(tokenData.amountFormated).plus(tokenAmountFormated);
            const feeFormated = new BigNumber(tokenData.feeFormated).plus(feeAmountFormated);
            const amountParsed = ethers.utils.parseUnits(
              amountFormated.toString(),
              tokenData.decimals > tokenValue.decimals ? tokenData.decimals : tokenValue.decimals,
            );
            const feeParsed = ethers.utils.parseUnits(
              feeFormated.toString(),
              tokenData.decimals > tokenValue.decimals ? tokenData.decimals : tokenValue.decimals,
            );

            aggregatedChain[chainIdParsed][tokenSymbol] = {
              txnCount: tokenValue.txnCount + tokenData.txnCount,
              symbol: tokenData.symbol,
              decimals: tokenData.decimals > tokenValue.decimals ? tokenData.decimals : tokenValue.decimals,
              amount: amountParsed.toString(),
              amountFormated: amountFormated.toString(),
              fee: feeParsed.toString(),
              feeFormated: feeFormated.toString(),
            };
          }
        }
      });
    });

    const symbolIdMap = {
      DUSD: "decentralized-usd",
      ETH: "ethereum",
      SOL: "solana",
      AVAX: "avalanche-2",
      MATIC: "matic-network",
      USDC: "usd-coin",
      USDT: "tether",
      CRV: "curve-dao-token",
      ROSE: "oasis-network",
      FTM: "fantom",
      CELO: "celo",
      BNB: "binancecoin",
      DAI: "dai",
      BTC: "bitcoin",
      KLAY: "klay-token",
      LUNC: "terra-luna",
      UST: "terrausd-wormhole",
      LUNA: "terra-luna-2",
      ACA: "acala",
      GLMR: "moonbeam",
      SUI: "sui",
    };

    const nativeCurrencyMap = {
      [CHAIN_ID_SOLANA]: "SOL",
      [CHAIN_ID_ETH]: "ETH",
      [CHAIN_ID_TERRA]: "LUNA",
      [CHAIN_ID_BSC]: "BNB",
      [CHAIN_ID_POLYGON]: "MATIC",
      [CHAIN_ID_AVAX]: "AVAX",
      [CHAIN_ID_OASIS]: "ROSE",
      [CHAIN_ID_FANTOM]: "FTM",
      [CHAIN_ID_ACALA]: "ACA",
      [CHAIN_ID_KLAYTN]: "KLAY",
      [CHAIN_ID_CELO]: "CELO",
      [CHAIN_ID_MOONBEAM]: "GLMR",
      [CHAIN_ID_SUI]: "SUI",
      [CHAIN_ID_ARBITRUM]: "ETH",
    };
    const gasMap = {
      [CHAIN_ID_SOLANA]: 0.000005,
      [CHAIN_ID_ETH]: 0.008949588956166872, // average 30 Gwei * 276946 gas = 0.008949588956166872 ETH
      [CHAIN_ID_TERRA]: 0,
      [CHAIN_ID_BSC]: 0.00070782, // average 3 Gwei * 235940 gas = 0.00070782 BNB
      [CHAIN_ID_POLYGON]: 0.036238316380764384, // average 137 Gwei * 263904 gas = 0.036238316380764384 MATIC
      [CHAIN_ID_AVAX]: 0.007325766, // average 0.0000000265 AVAX * 276444 gas = 0.007325766 AVAX
      [CHAIN_ID_OASIS]: 0.0260756,
      [CHAIN_ID_FANTOM]: 0.011089556903346718, // average 39.610936139 Gwei * 279,962 gas = 0.011089556903346718 FTM
      [CHAIN_ID_ACALA]: 0.013670024958,
      [CHAIN_ID_KLAYTN]: 0.009013175,
      [CHAIN_ID_CELO]: 0.00278418,
      [CHAIN_ID_MOONBEAM]: 0.038268793123831184, // average 137.505185348 Gwei * 278,308 gas = 0.038268793123831184 GLMR
      [CHAIN_ID_SUI]: 0.0004,
      [CHAIN_ID_ARBITRUM]: 0.0000000001,
    };
    const coinPriceResp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(symbolIdMap).join(",")}&vs_currencies=usd`,
    );
    const coinPriceJson = await coinPriceResp.json();

    console.log(
      "aggregated csv",
      "destinationChain,symbol,decimals,amount,amountFormated,fee,feeFormated,txnCount,totalIncome($),cost($),profit($)\n" +
        Object.keys(aggregatedChain)
          .map((chainId: any) => {
            const tokenArray = Object.keys(aggregatedChain[chainId]).map((tokenSymbol) => {
              const token = aggregatedChain[chainId][tokenSymbol];
              const tokenPrice = coinPriceJson[symbolIdMap[token.symbol as keyof typeof symbolIdMap] as string].usd;
              const income = new BigNumber(token.feeFormated).multipliedBy(tokenPrice);
              const nativeTokenPrice = nativeCurrencyMap[chainId as keyof typeof nativeCurrencyMap]
                ? coinPriceJson[
                    symbolIdMap[
                      nativeCurrencyMap[chainId as keyof typeof nativeCurrencyMap] as keyof typeof symbolIdMap
                    ] as string
                  ].usd
                : 0;
              const cost = new BigNumber(gasMap[chainId as keyof typeof gasMap] as number)
                .multipliedBy(token.txnCount)
                .multipliedBy(nativeTokenPrice);
              const profit = income.minus(cost);

              return `${toChainName(parseInt(chainId) as ChainId) || chainId},${token.symbol},${token.decimals},${
                token.amount
              },${token.amountFormated},${token.fee},${token.feeFormated},${token.txnCount},${income.toFixed(
                2,
              )},${cost.toFixed(2)},${profit.toFixed(2)}\n`;
            });

            tokenArray.sort((a, b) => {
              const [
                destinationChainA,
                symbolA,
                decimalsA,
                amountA,
                amountFormatedA,
                feeA,
                feeFormatedA,
                txnCountA,
                totalIncomeA,
                costA,
                profitA,
              ] = a.replace("\n", "").split(",");
              const [
                destinationChainB,
                symbolB,
                decimalsB,
                amountB,
                amountFormatedB,
                feeB,
                feeFormatedB,
                txnCountB,
                totalIncomeB,
                costB,
                profitB,
              ] = b.replace("\n", "").split(",");
              return parseFloat(profitA) > parseFloat(profitB) ? -1 : 1;
            });

            return tokenArray;
          })
          .flat()
          .flat()
          .join(""),
    );

    console.log(
      "total txn",
      Object.values(chains)
        .map((chain) => Object.values(chain).map((token) => token.txnCount))
        .flat()
        .flat()
        .reduce((a, b) => a + b, 0),
    );
  }
}

export async function countTxnWithArbiterFee() {
  await connectDB();

  await countTxn();
}
