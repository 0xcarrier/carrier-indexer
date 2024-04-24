import { TypeRegistry, Enum, Struct } from "@polkadot/types";
import { ethers } from "ethers";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { CLUSTER, MOONBEAM_BALANCE_PALLET, MOONBEAM_PARACHAIN_ID, Polkachain, getPolkaChains } from "../bridge";
import { encodeAddress } from "@polkadot/util-crypto";
import { decodeAddress, blake2AsU8a } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { CHAIN_ID_MOONBEAM, ChainId } from "../utils/wormhole";

const polkadotProviders: { [chainId: number]: ApiPromise } = {};

export async function getPolkadotProviderWithPolkaChainId(chainId: Polkachain): Promise<ApiPromise> {
  if (polkadotProviders[chainId]) {
    return polkadotProviders[chainId];
  }

  const polkachains = getPolkaChains();
  const rpcUrl = polkachains[chainId]?.rpcUrl;

  if (!rpcUrl) {
    throw new Error(`can't find polkachain(${chainId}) rpcUrl`);
  }

  const wsProvider = new WsProvider(rpcUrl, 1000);

  wsProvider.on("error", (e) => {
    console.error(`WebSocket error happens. chainId: ${chainId}`, e);
  });

  wsProvider.on("connected", () => {
    console.log(`WebSocket connected. chainId: ${chainId}`);
  });

  wsProvider.on("disconnected", () => {
    console.error(`WebSocket connection closed unexpectedly. chainId: ${chainId}`);
  });

  console.log(`WebSocket connecting. chainId: ${chainId}`);

  const api = await ApiPromise.create({ provider: wsProvider });

  polkadotProviders[chainId] = api;

  return api;
}

export function getParachaiCurrencyHexAddressByAssetId(assetId: string) {
  const hex = ethers.BigNumber.from(assetId).toHexString();

  return "0xffffffff" + hex.replace("0x", "");
}

// convert to hex
const registry = new TypeRegistry();

/**Moonbeam's MRL precompile expects a VersionedUserAction object as a payload.*/
class VersionedUserAction extends Enum {
  constructor(value?: any) {
    super(registry, { V1: XcmRoutingUserAction }, value);
  }
}

class XcmRoutingUserAction extends Struct {
  constructor(value?: any) {
    super(registry, { destination: "VersionedMultiLocation" }, value);
  }
}

// reference: https://github.com/jboetticher/mrl-example/blob/main/src/MoonbeamRoutedLiquidityPayloads.ts
export function createMRLPayload(chainId: Polkachain, account: string): Uint8Array {
  // Create a multilocation object based on the target parachain's account type
  const multilocation = {
    V1: {
      parents: 1,
      interior: {
        X2: [{ Parachain: chainId }, { AccountId32: { id: account } }],
      },
    },
  };

  // Format multilocation object as a Polkadot.js type
  const destination = registry.createType("VersionedMultiLocation", multilocation);
  // Wrap and format the MultiLocation object into the precompile's input type
  const userAction = new XcmRoutingUserAction({ destination });
  const versionedUserAction = new VersionedUserAction({ V1: userAction });

  console.log("Versioned User Action JSON:", JSON.stringify(versionedUserAction.toJSON()));
  console.log("Versioned User Action SCALE:", versionedUserAction.toHex());
  console.log("Versioned User Action toRawType", versionedUserAction.toRawType(), versionedUserAction.toPrimitive());
  // SCALE encode resultant precompile formatted objects
  return versionedUserAction.toU8a();
}

export enum ParachainBridgeType {
  MRL,
  XCM,
}

export type ParsedParachainTxHash =
  | {
      bridgeType: ParachainBridgeType;
      moonbeamBlockHash: string;
      moonbeamExtrinsicHash: string;
      moonbeamTransactionHash: string;
      parachainId: Polkachain;
      parachainBlockHash: string;
      parachainExtrinsicHash: string;
      messageHash: string;
    }
  | {
      bridgeType: ParachainBridgeType;
      sourceMessageHash: string;
      sourceAssetId: string;
      sourceParachainId: Polkachain;
      sourceParachainBlockHash: string;
      sourceParachainExtrinsicHash: string;
      targetMessageHash: string;
      targetAssetId: string;
      targetParachainId: Polkachain;
      targetParachainBlockHash: string;
      targetParachainExtrinsicHash: string;
    };

export function parseParachainTxHash(txHash: string): ParsedParachainTxHash | undefined {
  const txHashString = ethers.utils.toUtf8String(txHash);
  const [bridgeType, params] = txHashString.split(":");

  // legacy issue, first version of the parachain tx hash doesn't contain the bridge type, so we see it as mrl by default
  if (bridgeType.startsWith("0x")) {
    const [
      moonbeamBlockHash,
      moonbeamExtrinsicHash,
      moonbeamTransactionHash,
      parachainBlockHash,
      parachainExtrinsicHash,
      messageHash,
    ] = bridgeType.split(",");

    return {
      bridgeType: ParachainBridgeType.MRL,
      moonbeamBlockHash,
      moonbeamExtrinsicHash,
      moonbeamTransactionHash,
      parachainId: parseInt("0"),
      parachainBlockHash,
      parachainExtrinsicHash,
      messageHash,
    };
  } else if (bridgeType === "mrl") {
    const [
      moonbeamBlockHash,
      moonbeamExtrinsicHash,
      moonbeamTransactionHash,
      parachainId,
      parachainBlockHash,
      parachainExtrinsicHash,
      messageHash,
    ] = params.split(",");

    return {
      bridgeType: ParachainBridgeType.MRL,
      moonbeamBlockHash,
      moonbeamExtrinsicHash,
      moonbeamTransactionHash,
      parachainId: parseInt(parachainId),
      parachainBlockHash,
      parachainExtrinsicHash,
      messageHash,
    };
  } else if (bridgeType === "xcm") {
    const [
      sourceMessageHash,
      sourceAssetId,
      sourceParachainId,
      sourceParachainBlockHash,
      sourceParachainExtrinsicHash,
      targetMessageHash,
      targetAssetId,
      targetParachainId,
      targetParachainBlockHash,
      targetParachainExtrinsicHash,
    ] = params.split(",");

    return {
      bridgeType: ParachainBridgeType.XCM,
      sourceMessageHash,
      sourceAssetId,
      sourceParachainId: parseInt(sourceParachainId),
      sourceParachainBlockHash,
      sourceParachainExtrinsicHash,
      targetMessageHash,
      targetAssetId,
      targetParachainId: parseInt(targetParachainId),
      targetParachainBlockHash,
      targetParachainExtrinsicHash,
    };
  }
}
export interface ParsedPolkachainPayload {
  parachainId: Polkachain;
  accountId: string;
}

export async function parsePolkachainTxPayload(payload: Buffer): Promise<ParsedPolkachainPayload | undefined> {
  try {
    const registry = new TypeRegistry();

    registry.register({
      VersionedUserAction: {
        _enum: { V1: "XcmRoutingUserAction" },
      },
      XcmRoutingUserAction: {
        destination: "VersionedMultiLocation",
      },
    });
    const versionedUserAction = registry.createType("VersionedUserAction", payload) as VersionedUserAction;
    const versionedUserActionJSON = versionedUserAction.toJSON() as any;
    const parachainId = versionedUserActionJSON.v1.destination.v1.interior.x2[0].parachain as Polkachain;
    const parachainApi = await getPolkadotProviderWithPolkaChainId(parachainId);
    const addressPrefix = await getParachainAddressPrefix(parachainApi);
    const accountId = encodeAddress(
      versionedUserActionJSON.v1.destination.v1.interior.x2[1].accountId32.id as string,
      addressPrefix,
    );
    console.log("versionedUserActionJSON", JSON.stringify(versionedUserActionJSON));

    return {
      parachainId,
      accountId,
    };
  } catch (e) {
    console.error(e);
  }
}

export async function getParachainAddressPrefix(api: ApiPromise) {
  const chainInfo = api.registry.getChainProperties();
  const addressPrefix = chainInfo ? chainInfo.ss58Format.value.toNumber() : undefined;

  return addressPrefix;
}

// parachain extrinsic hash is not unique, we need to combine it with block hash, and we can only get messageHash from event
// if we miss the event on moonbeam, then we can't retrieve it anymore.
// so we have to get block hash, extrinsic hash, and messageHash from event
// and put it into a string to generate a unique hash
export function generateMRLTransactionHash(options: {
  moonbeamBlockHash: string;
  moonbeamExtrinsicHash: string;
  moonbeamTransactionHash: string;
  messageHash: string;
  parachainId: Polkachain;
  parachainBlockHash: string;
  parachainExtrinsicHash: string;
}) {
  const {
    moonbeamBlockHash,
    moonbeamExtrinsicHash,
    moonbeamTransactionHash,
    messageHash,
    parachainId,
    parachainBlockHash,
    parachainExtrinsicHash,
  } = options;

  const hash = ethers.utils.hexlify(
    new TextEncoder().encode(
      `mrl:${moonbeamBlockHash},${moonbeamExtrinsicHash},${moonbeamTransactionHash},${parachainId},${parachainBlockHash},${parachainExtrinsicHash},${messageHash}`,
    ),
  );

  console.log("mrl parachain tx hash generated. options:", JSON.stringify(options), ", hash: ", hash);

  return hash;
}

// parachain extrinsic hash is not unique, we need to combine it with block hash, and we can only get messageHash from event
// if we miss the event on moonbeam, then we can't retrieve it anymore.
// so we have to get block hash, extrinsic hash, and messageHash from event
// and put it into a string to generate a unique hash
export function generateXCMTransactionHash(options: {
  sourceMessageHash: string;
  sourceAssetId: string;
  sourceParachainId: Polkachain;
  sourceParachainBlockHash: string;
  sourceParachainExtrinsicHash: string;
  targetMessageHash: string;
  targetAssetId: string;
  targetParachainId: Polkachain;
  targetParachainBlockHash: string;
  targetParachainExtrinsicHash: string;
}) {
  const {
    sourceMessageHash,
    sourceAssetId,
    sourceParachainId,
    sourceParachainBlockHash,
    sourceParachainExtrinsicHash,
    targetMessageHash,
    targetAssetId,
    targetParachainId,
    targetParachainBlockHash,
    targetParachainExtrinsicHash,
  } = options;

  const hash = ethers.utils.hexlify(
    new TextEncoder().encode(
      `xcm:${sourceMessageHash},${sourceAssetId},${sourceParachainId},${sourceParachainBlockHash},${sourceParachainExtrinsicHash},${targetMessageHash},${targetAssetId},${targetParachainId},${targetParachainBlockHash},${targetParachainExtrinsicHash}`,
    ),
  );

  console.log("xcm parachain tx hash generated. options:", JSON.stringify(options), ", hash: ", hash);

  return hash;
}

export interface PolkachainToken {
  assetId: string;
  location: any;
  assetIdOnMoonBeam?: string;
  tokenAddressOnMoonbeam: string;
  oringinAddress: string;
  originChainId: ChainId;
  parachainSymbol?: string;
  symbol: string;
  name?: string;
  decimals: number;
  isNative: boolean;
}

type PolkachainTokens = {
  [chainId: number]: PolkachainToken[];
};

export const PolkachainTokens: PolkachainTokens =
  CLUSTER === "mainnet"
    ? {
        [Polkachain.HydraDX]: [
          {
            assetId: "23",
            tokenAddressOnMoonbeam: "0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f",
            oringinAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            originChainId: 2,
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f",
                      },
                    },
                  ],
                },
              },
            },
            symbol: "USDT",
            name: "USDT (Wormhole)",
            decimals: 6,
            isNative: false,
          },
          {
            assetId: "18",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0x06e605775296e851ff43b4daa541bb0984e9d6fd",
                      },
                    },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0x06e605775296e851FF43b4dAa541Bb0984E9D6fD",
            oringinAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
            originChainId: 2,
            symbol: "DAI",
            name: "DAI (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "19",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0xe57ebd2d67b462e9926e04a8e33f01cd0d64346d",
                      },
                    },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D",
            oringinAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
            originChainId: 2,
            symbol: "WBTC",
            name: "WBTC (Wormhole)",
            decimals: 8,
            isNative: false,
          },
          {
            assetId: "20",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0xab3f0245b83feb11d15aaffefd7ad465a59817ed",
                      },
                    },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0xab3f0245B83feB11d15AAffeFD7AD465a59817eD",
            oringinAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            originChainId: 2,
            symbol: "WETH",
            name: "WETH (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "21",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0x931715fee2d06333043d11f658c8ce934ac61d0c",
                      },
                    },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0x931715FEE2d06333043d11F658C8CE934aC61D0c",
            oringinAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            originChainId: 2,
            symbol: "USDC",
            name: "USD Coin (Ethereum)",
            decimals: 6,
            isNative: false,
          },
        ],
        [Polkachain.Interlay]: [
          {
            assetId: "4",
            tokenAddressOnMoonbeam: "0x06e605775296e851FF43b4dAa541Bb0984E9D6fD",
            oringinAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
            originChainId: 2,
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0x06e605775296e851ff43b4daa541bb0984e9d6fd",
                      },
                    },
                  ],
                },
              },
            },
            symbol: "DAI",
            name: "DAI (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "9",
            tokenAddressOnMoonbeam: "0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D",
            oringinAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
            originChainId: 2,
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0xe57ebd2d67b462e9926e04a8e33f01cd0d64346d",
                      },
                    },
                  ],
                },
              },
            },
            symbol: "WBTC",
            name: "WBTC (Wormhole)",
            decimals: 8,
            isNative: false,
          },
          {
            assetId: "6",
            tokenAddressOnMoonbeam: "0xab3f0245B83feB11d15AAffeFD7AD465a59817eD",
            oringinAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            originChainId: 2,
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0xab3f0245b83feb11d15aaffefd7ad465a59817ed",
                      },
                    },
                  ],
                },
              },
            },
            symbol: "WETH",
            name: "WETH (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "8",
            tokenAddressOnMoonbeam: "0x931715FEE2d06333043d11F658C8CE934aC61D0c",
            oringinAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            originChainId: 2,
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    {
                      Parachain: 2004,
                    },
                    {
                      PalletInstance: 110,
                    },
                    {
                      AccountKey20: {
                        network: null,
                        key: "0x931715fee2d06333043d11f658c8ce934ac61d0c",
                      },
                    },
                  ],
                },
              },
            },
            symbol: "USDC",
            name: "USD Coin (Ethereum)",
            decimals: 6,
            isNative: false,
          },
        ],
      }
    : {
        [Polkachain.Manta]: [
          {
            assetId: "9",
            location: {
              V1: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: "Any", key: "0x566c1cebc6a4afa1c122e039c4bebe77043148ee" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0x566c1cebc6A4AFa1C122E039C4BEBe77043148Ee",
            oringinAddress: "0xf1277d1ed8ad466beddf92ef448a132661956621",
            originChainId: 10,
            symbol: "FTM",
            name: "FTM (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "8",
            location: {
              V1: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: "Any", key: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9",
            oringinAddress: "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
            originChainId: 2,
            symbol: "USDC",
            name: "USDC (Wormhole)",
            decimals: 6,
            isNative: false,
          },
        ],
        [Polkachain.HydraDX]: [
          {
            assetId: "1000002",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: null, key: "0x566c1cebc6a4afa1c122e039c4bebe77043148ee" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0x566c1cebc6A4AFa1C122E039C4BEBe77043148Ee",
            oringinAddress: "0xf1277d1ed8ad466beddf92ef448a132661956621",
            originChainId: 10,
            symbol: "FTM",
            name: "FTM (Wormhole)",
            decimals: 18,
            isNative: false,
          },
          {
            assetId: "1000001",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: null, key: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9",
            oringinAddress: "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
            originChainId: 2,
            symbol: "USDC",
            name: "USDC (Wormhole)",
            decimals: 6,
            isNative: false,
          },
        ],
        [Polkachain.Interlay]: [
          {
            assetId: "2",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: null, key: "0x566c1cebc6A4AFa1C122E039C4BEBe77043148Ee" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0x566c1cebc6A4AFa1C122E039C4BEBe77043148Ee",
            oringinAddress: "0xf1277d1ed8ad466beddf92ef448a132661956621",
            originChainId: 10,
            symbol: "FTM",
            name: "FTM (Wormhole)",
            decimals: 18,
            isNative: false,
          },
        ],
        [Polkachain.PeaqAgung]: [
          {
            assetId: "131",
            location: {
              V3: {
                parents: 1,
                interior: {
                  X3: [
                    { Parachain: 1000 },
                    { PalletInstance: 48 },
                    { AccountKey20: { network: null, key: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9" } },
                  ],
                },
              },
            },
            tokenAddressOnMoonbeam: "0xe5de10c4b744bac6b783faf8d9b9fdff14acc3c9",
            oringinAddress: "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
            originChainId: 2,
            symbol: "USDC",
            parachainSymbol: "XCUSDC",
            name: "USDC (Wormhole)",
            decimals: 6,
            isNative: false,
          },
        ],
      };

export interface XcGLMR {
  assetId: string;
  location: any;
  decimals: number;
  symbol: string;
}

type PolkachainXcGLMR = {
  [chainId: number]: XcGLMR;
};

export const PolkachainXcGLMR: PolkachainXcGLMR =
  CLUSTER === "mainnet"
    ? {
        [Polkachain.HydraDX]: {
          assetId: "16",
          location: {
            V3: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "GLMR",
        },
        [Polkachain.Interlay]: {
          assetId: "10",
          location: {
            V3: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "GLMR",
        },
      }
    : {
        [Polkachain.HydraDX]: {
          assetId: "1",
          location: {
            V3: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "DEV",
        },
        [Polkachain.Manta]: {
          assetId: "10",
          location: {
            V1: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "DEV",
        },
        [Polkachain.Interlay]: {
          assetId: "1",
          location: {
            V3: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "DEV",
        },
        [Polkachain.PeaqAgung]: {
          assetId: "130",
          location: {
            V3: {
              parents: 1,
              interior: {
                X2: [{ Parachain: MOONBEAM_PARACHAIN_ID }, { PalletInstance: MOONBEAM_BALANCE_PALLET }],
              },
            },
          },
          decimals: 18,
          symbol: "MBA",
        },
      };

// reference: https://github.com/Moonsong-Labs/xcm-tools/blob/main/scripts/calculate-multilocation-derivative-account.ts
export function calculateMultilocationDerivativeAccount(options: {
  address: string;
  chainId: Polkachain;
  isParent: boolean;
}) {
  const { address, chainId, isParent } = options;
  // Check Ethereum Address and/or Decode
  let decodedAddress;
  const ethAddress = address.length === 42;
  const accType = ethAddress ? "AccountKey20" : "AccountId32";

  // Decode Address if Needed
  if (!ethAddress) {
    decodedAddress = decodeAddress(address);
  } else {
    decodedAddress = hexToU8a(address);
  }

  // Describe Family
  // https://github.com/paritytech/polkadot/blob/master/xcm/xcm-builder/src/location_conversion.rs#L96-L118
  let family = "SiblingChain";
  if (!isParent && chainId) family = "ChildChain";
  else if (isParent && !chainId) family = "ParentChain";

  // Calculate Hash Component
  const registry = new TypeRegistry();
  let toHash = new Uint8Array([
    ...new TextEncoder().encode(family),
    ...(chainId ? registry.createType("Compact<u32>", chainId).toU8a() : []),
    ...registry.createType("Compact<u32>", accType.length + (ethAddress ? 20 : 32)).toU8a(),
    ...new TextEncoder().encode(accType),
    ...decodedAddress,
  ]);

  console.log(`Remote Origin calculated as ${family}`);

  const MLDAccountAddress = u8aToHex(blake2AsU8a(toHash).slice(0, 20));

  console.log(`${accType}: ${address}, ${MLDAccountAddress}`);

  return MLDAccountAddress;
}

export async function formatAccountId(accountId: Buffer, parachainId: Buffer) {
  if (!accountId || !parachainId) {
    return;
  }

  const _parachainId = parseInt(parachainId.toString());
  const api = await getPolkadotProviderWithPolkaChainId(_parachainId as Polkachain);
  const addressPrefix = await getParachainAddressPrefix(api);
  const _accountId = encodeAddress(accountId, addressPrefix);

  return _accountId;
}

export function isPolkadotXCMV3(chainId: ChainId | Polkachain) {
  return (
    chainId === CHAIN_ID_MOONBEAM ||
    chainId === Polkachain.HydraDX ||
    chainId === Polkachain.Interlay ||
    chainId === Polkachain.PeaqAgung
  );
}

export async function getMoonbeamTransactionHashByExtrinsic(options: {
  blockHash: string;
  extrinsicHash: string;
}): Promise<string | undefined> {
  const { blockHash, extrinsicHash } = options;
  const api = await getPolkadotProviderWithPolkaChainId(MOONBEAM_PARACHAIN_ID);
  const block = await api.rpc.chain.getBlock(blockHash);
  const extrinsicIndex = block.block.extrinsics.findIndex((item, index) => {
    return item.hash.toHex().toLowerCase() === extrinsicHash;
  });
  const apiAt = await api.at(blockHash);
  const events: any = await apiAt.query.system.events();
  const extrinsicEvents = events.filter(
    (item: any) => item.phase.isApplyExtrinsic && item.phase.asApplyExtrinsic.eq(extrinsicIndex),
  );
  const ethereumExecutedEvent = extrinsicEvents.find(
    (item: any) => item.event.section === "ethereum" && item.event.method === "Executed",
  );

  return (ethereumExecutedEvent?.event.data as any)?.transactionHash?.toHex();
}
