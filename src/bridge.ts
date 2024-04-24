/**
 * JSON storing constants relating to the bridge
 *
 * Refer to https://book.wormhole.com/reference/contracts.html
 * for Wormhole's bridge addresses
 *
 */
import {
  tryNativeToUint8Array,
  isEVMChain,
  CONTRACTS,
  ChainId,
  CHAIN_ID_ETH,
  CHAIN_ID_POLYGON,
  CHAIN_ID_BSC,
  CHAIN_ID_ACALA,
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_SOLANA,
  CHAIN_ID_AURORA,
  CHAIN_ID_CELO,
  CHAIN_ID_KARURA,
  CHAIN_ID_KLAYTN,
  CHAIN_ID_OASIS,
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_OPTIMISM,
  CHAIN_ID_BASE,
} from "./utils/wormhole";
import { ethers } from "ethers";
import { providerCountMonitor, providerErrorCountMonitor, providerLatencyMonitor } from "./utils/prometheus";
import { randomInt } from "crypto";

export const CLUSTER = process.env.CLUSTER;

export interface CHAIN_INFO {
  chainId: ChainId;
  evmChainId?: number;
  wormholeCoreBridge: string;
  wormholeTokenBridge: string;
  wormholeNFTBridge: string;
  rpcUrls: string[];
}

export enum BRIDGE_CHAINS {
  SOLANA,
  ACALA,
  ARBITRUM,
  AURORA,
  AVAX,
  BINANCE,
  CELO,
  ETHEREUM,
  FANTOM,
  KARURA,
  KLAYTN,
  MOONBEAM,
  OASIS,
  POLYGON,
  OPTIMISM,
  BASE,
}

export enum Polkachain {
  MoonbaseBeta = 888,
  MoonbaseAlpha = 1000,
  Moonbeam = 2004,
  Interlay = 2032,
  HydraDX = 2034,
  PeaqAgung = 3013,
  Acala = 2000,
  Phala = 2035,
  Manta = 2104,
  // polkadot haven't supportted by wormhole and it's not a parachain so we just give it a mock id in frontend to identify it
  Polkadot = 100000,
}

enum NETWORK {
  MAINNET,
  TESTNET,
}

type CHAIN_INFO_MAP = { [k in keyof typeof BRIDGE_CHAINS]: CHAIN_INFO };

const providers: { [chainId: number]: MetricsProvider[] } = {};

export const ETH_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 1 : CLUSTER === "testnet" ? 5 : 0;
export const BSC_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 56 : CLUSTER === "testnet" ? 97 : 0;
export const POLYGON_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 137 : CLUSTER === "testnet" ? 80001 : 0;
export const AVAX_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 43114 : CLUSTER === "testnet" ? 43113 : 0;
export const OASIS_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 42262 : CLUSTER === "testnet" ? 42261 : 0;
export const AURORA_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 1313161554 : CLUSTER === "testnet" ? 1313161555 : 0;
export const FANTOM_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 250 : CLUSTER === "testnet" ? 4002 : 0;
export const KARURA_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 686 : CLUSTER === "testnet" ? 596 : 0;
export const ACALA_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 787 : CLUSTER === "testnet" ? 597 : 0;
export const KLAYTN_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 8217 : CLUSTER === "testnet" ? 1001 : 0;
export const CELO_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 42220 : CLUSTER === "testnet" ? 44787 : 0;
export const MOONBEAM_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 1284 : CLUSTER === "testnet" ? 1287 : 0;
export const ARBITRUM_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 42161 : CLUSTER === "testnet" ? 421613 : 0;
export const OPTIMISM_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 10 : CLUSTER === "testnet" ? 420 : 0;
export const BASE_NETWORK_CHAIN_ID = CLUSTER === "mainnet" ? 8453 : CLUSTER === "testnet" ? 84531 : 0;

export const BRIDGE: { [k in keyof typeof NETWORK]: CHAIN_INFO_MAP } = {
  MAINNET: {
    SOLANA: {
      chainId: CHAIN_ID_SOLANA,
      wormholeCoreBridge: CONTRACTS.MAINNET.solana.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.solana.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.solana.token_bridge,
      rpcUrls: [`https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`],
    },
    ACALA: {
      chainId: CHAIN_ID_ACALA,
      evmChainId: ACALA_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.acala.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.acala.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.acala.token_bridge,
      rpcUrls: ["https://eth-rpc-acala.aca-api.network", "https://rpc.evm.acala.network"],
    },
    ARBITRUM: {
      chainId: CHAIN_ID_ARBITRUM,
      evmChainId: ARBITRUM_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.arbitrum.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.arbitrum.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.arbitrum.token_bridge,
      rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    },
    AURORA: {
      chainId: CHAIN_ID_AURORA,
      evmChainId: AURORA_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.aurora.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.aurora.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.aurora.token_bridge,
      rpcUrls: ["https://mainnet.aurora.dev"],
    },
    AVAX: {
      chainId: CHAIN_ID_AVAX,
      evmChainId: AVAX_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.avalanche.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.avalanche.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.avalanche.token_bridge,
      rpcUrls: ["https://avalanche-c-chain.publicnode.com"],
    },
    BINANCE: {
      chainId: CHAIN_ID_BSC,
      evmChainId: BSC_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.bsc.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.bsc.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.bsc.token_bridge,
      // quicknode bnb mainnet rpc is not stable, so we use binance instead
      rpcUrls: [`https://bsc.blockpi.network/v1/rpc/${process.env.BLOCKPI_KEY}`],
    },
    CELO: {
      chainId: CHAIN_ID_CELO,
      evmChainId: CELO_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.celo.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.celo.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.celo.token_bridge,
      rpcUrls: [`https://celo-mainnet.infura.io/v3/${process.env.INFURA_KEY}`],
    },
    ETHEREUM: {
      chainId: CHAIN_ID_ETH,
      evmChainId: ETH_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.ethereum.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.ethereum.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.ethereum.token_bridge,
      rpcUrls: [`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`],
    },
    FANTOM: {
      chainId: CHAIN_ID_FANTOM,
      evmChainId: FANTOM_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.fantom.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.fantom.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.fantom.token_bridge,
      // quicknode fantom mainnet rpc is not stable, so we use onfinality instead
      rpcUrls: ["https://rpcapi.fantom.network"],
    },
    KARURA: {
      chainId: CHAIN_ID_KARURA,
      evmChainId: KARURA_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.karura.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.karura.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.karura.token_bridge,
      rpcUrls: ["https://rpc.evm.karura.network", "https://eth-rpc-karura.aca-api.network"],
    },
    KLAYTN: {
      chainId: CHAIN_ID_KLAYTN,
      evmChainId: KLAYTN_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.klaytn.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.klaytn.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.klaytn.token_bridge,
      rpcUrls: ["https://klaytn-pokt.nodies.app"],
    },
    MOONBEAM: {
      chainId: CHAIN_ID_MOONBEAM,
      evmChainId: MOONBEAM_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.moonbeam.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.moonbeam.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.moonbeam.token_bridge,
      rpcUrls: ["https://rpc.api.moonbeam.network"],
    },
    OASIS: {
      chainId: CHAIN_ID_OASIS,
      evmChainId: OASIS_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.oasis.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.oasis.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.oasis.token_bridge,
      rpcUrls: ["https://emerald.oasis.dev"],
    },
    POLYGON: {
      chainId: CHAIN_ID_POLYGON,
      evmChainId: POLYGON_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.polygon.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.polygon.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.polygon.token_bridge,
      rpcUrls: ["https://rpc-mainnet.matic.quiknode.pro"],
    },
    OPTIMISM: {
      chainId: CHAIN_ID_OPTIMISM,
      evmChainId: OPTIMISM_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.optimism.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.optimism.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.optimism.token_bridge,
      rpcUrls: ["https://mainnet.optimism.io"],
    },
    BASE: {
      chainId: CHAIN_ID_BASE,
      evmChainId: BASE_NETWORK_CHAIN_ID,
      wormholeCoreBridge: CONTRACTS.MAINNET.base.core,
      wormholeNFTBridge: CONTRACTS.MAINNET.base.nft_bridge,
      wormholeTokenBridge: CONTRACTS.MAINNET.base.token_bridge,
      rpcUrls: ["https://mainnet.base.org"],
    },
  },
  TESTNET: {
    SOLANA: {
      chainId: CHAIN_ID_SOLANA,
      wormholeCoreBridge: CONTRACTS.TESTNET.solana.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.solana.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.solana.token_bridge,
      // wormhole use solana devnet to be test net
      rpcUrls: ["https://rpc.ankr.com/solana_devnet"],
    },
    ACALA: {
      chainId: CHAIN_ID_ACALA,
      wormholeCoreBridge: CONTRACTS.TESTNET.acala.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.acala.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.acala.token_bridge,
      rpcUrls: ["https://eth-rpc-acala-testnet.aca-staging.network"],
    },
    ARBITRUM: {
      chainId: CHAIN_ID_ARBITRUM,
      wormholeCoreBridge: CONTRACTS.TESTNET.arbitrum.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.arbitrum.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.arbitrum.token_bridge,
      rpcUrls: [
        "https://arbitrum-goerli.publicnode.com",
        "https://arbitrum-goerli.public.blastapi.io",
        "https://arbitrum-goerli.blockpi.network/v1/rpc/public",
        "https://goerli-rollup.arbitrum.io/rpc",
      ],
    },
    AURORA: {
      chainId: CHAIN_ID_AURORA,
      wormholeCoreBridge: CONTRACTS.TESTNET.aurora.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.aurora.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.aurora.token_bridge,
      rpcUrls: ["https://testnet.aurora.dev", "https://endpoints.omniatech.io/v1/aurora/testnet/public"],
    },
    AVAX: {
      chainId: CHAIN_ID_AVAX,
      wormholeCoreBridge: CONTRACTS.TESTNET.avalanche.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.avalanche.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.avalanche.token_bridge,
      rpcUrls: [
        "https://api.avax-test.network/ext/bc/C/rpc",
        "https://rpc.ankr.com/avalanche_fuji",
        "https://avalanche-fuji-c-chain.publicnode.com",
        "https://avalanche-fuji.blockpi.network/v1/rpc/public",
      ],
    },
    BINANCE: {
      chainId: CHAIN_ID_BSC,
      wormholeCoreBridge: CONTRACTS.TESTNET.bsc.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.bsc.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.bsc.token_bridge,
      rpcUrls: [
        "https://data-seed-prebsc-1-s1.binance.org:8545",
        "https://bsc-testnet.public.blastapi.io",
        "https://bsc-testnet.publicnode.com",
        "https://bsc-testnet.blockpi.network/v1/rpc/public",
        "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
        "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
        "https://data-seed-prebsc-1-s2.bnbchain.org:8545",
        "https://data-seed-prebsc-2-s2.bnbchain.org:8545",
      ],
    },
    CELO: {
      chainId: CHAIN_ID_CELO,
      wormholeCoreBridge: CONTRACTS.TESTNET.celo.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.celo.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.celo.token_bridge,
      rpcUrls: ["https://alfajores-forno.celo-testnet.org"],
    },
    ETHEREUM: {
      chainId: CHAIN_ID_ETH,
      wormholeCoreBridge: CONTRACTS.TESTNET.ethereum.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.ethereum.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.ethereum.token_bridge,
      rpcUrls: [
        "https://goerli.blockpi.network/v1/rpc/public",
        "https://rpc.ankr.com/eth_goerli",
        "https://ethereum-goerli.publicnode.com",
        "https://eth-goerli.public.blastapi.io",
      ],
    },
    FANTOM: {
      chainId: CHAIN_ID_FANTOM,
      wormholeCoreBridge: CONTRACTS.TESTNET.fantom.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.fantom.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.fantom.token_bridge,
      rpcUrls: [
        "https://rpc.ankr.com/fantom_testnet",
        "https://rpc.testnet.fantom.network",
        "https://fantom-testnet.publicnode.com",
      ],
    },
    KARURA: {
      chainId: CHAIN_ID_KARURA,
      wormholeCoreBridge: CONTRACTS.TESTNET.karura.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.karura.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.karura.token_bridge,
      rpcUrls: ["https://eth-rpc-karura-testnet.aca-staging.network"],
    },
    KLAYTN: {
      chainId: CHAIN_ID_KLAYTN,
      wormholeCoreBridge: CONTRACTS.TESTNET.klaytn.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.klaytn.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.klaytn.token_bridge,
      rpcUrls: [
        "https://api.baobab.klaytn.net:8651",
        "https://public-en-baobab.klaytn.net",
        "https://rpc.ankr.com/klaytn_testnet",
        "https://klaytn-baobab.blockpi.network/v1/rpc/public",
      ],
    },
    MOONBEAM: {
      chainId: CHAIN_ID_MOONBEAM,
      wormholeCoreBridge: CONTRACTS.TESTNET.moonbeam.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.moonbeam.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.moonbeam.token_bridge,
      rpcUrls: [
        "https://moonbeam-alpha.api.onfinality.io/public",
        "https://rpc.api.moonbase.moonbeam.network",
        "https://rpc.testnet.moonbeam.network",
        "https://moonbase-alpha.public.blastapi.io",
      ],
    },
    OASIS: {
      chainId: CHAIN_ID_OASIS,
      wormholeCoreBridge: CONTRACTS.TESTNET.oasis.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.oasis.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.oasis.token_bridge,
      rpcUrls: ["https://testnet.emerald.oasis.dev"],
    },
    POLYGON: {
      chainId: CHAIN_ID_POLYGON,
      wormholeCoreBridge: CONTRACTS.TESTNET.polygon.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.polygon.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.polygon.token_bridge,
      rpcUrls: [
        "https://polygon-testnet.public.blastapi.io",
        "https://rpc.ankr.com/polygon_mumbai",
        "https://polygon-mumbai.blockpi.network/v1/rpc/public",
        "https://polygon-mumbai-bor.publicnode.com",
      ],
    },
    OPTIMISM: {
      chainId: CHAIN_ID_OPTIMISM,
      wormholeCoreBridge: CONTRACTS.TESTNET.optimism.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.optimism.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.optimism.token_bridge,
      rpcUrls: [
        "https://optimism-goerli.publicnode.com",
        "https://optimism-goerli.public.blastapi.io",
        "https://optimism-goerli.blockpi.network/v1/rpc/public",
        "https://goerli.optimism.io",
      ],
    },
    BASE: {
      chainId: CHAIN_ID_BASE,
      wormholeCoreBridge: CONTRACTS.TESTNET.base.core,
      wormholeNFTBridge: CONTRACTS.TESTNET.base.nft_bridge,
      wormholeTokenBridge: CONTRACTS.TESTNET.base.token_bridge,
      rpcUrls: [
        "https://goerli.base.org",
        "https://base-goerli.publicnode.com",
        "https://base-goerli.blockpi.network/v1/rpc/public",
        "https://base-goerli.public.blastapi.io",
      ],
    },
  },
};

export interface POLKACHAIN_INFO {
  rpcUrl: string;
}

type POLKACHAIN_INFO_MAP = { [k: number]: POLKACHAIN_INFO };

export const POLKACHAIN: { [k in keyof typeof NETWORK]: POLKACHAIN_INFO_MAP } = {
  MAINNET: {
    [Polkachain.Moonbeam]: {
      rpcUrl: "wss://moonbeam-rpc.dwellir.com",
    },
    [Polkachain.HydraDX]: {
      rpcUrl: "wss://hydradx-rpc.dwellir.com",
    },
    [Polkachain.Interlay]: {
      rpcUrl: "wss://interlay-rpc.dwellir.com",
    },
  },
  TESTNET: {
    [Polkachain.MoonbaseAlpha]: {
      rpcUrl: "wss://wss.api.moonbase.moonbeam.network",
    },
    [Polkachain.HydraDX]: {
      rpcUrl: "wss://hydradx-moonbase-rpc.play.hydration.cloud",
    },
    [Polkachain.Manta]: {
      rpcUrl: "wss://c1.manta.moonsea.systems",
    },
    [Polkachain.Interlay]: {
      rpcUrl: "wss://interlay-moonbeam-alphanet.interlay.io/parachain",
    },
    [Polkachain.PeaqAgung]: {
      rpcUrl: "wss://moonbeam.peaq.network",
    },
  },
};

export const MOONBEAM_MRL_PRECOMPILE_ADDRESS =
  CLUSTER === "mainnet" ? "0x0000000000000000000000000000000000000816" : "0x0000000000000000000000000000000000000816";

export const MOONBEAM_BATCH_PRECOMPILE_ADDRESS =
  CLUSTER === "mainnet" ? "0x0000000000000000000000000000000000000808" : "0x0000000000000000000000000000000000000808";
export const MOONBEAM_XCM_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000804";

export const MOONBEAM_ROUTED_LIQUIDITY_PRECOMPILE = tryNativeToUint8Array(
  MOONBEAM_MRL_PRECOMPILE_ADDRESS,
  CHAIN_ID_MOONBEAM,
);

export const MOONBEAM_BALANCE_PALLET = CLUSTER === "mainnet" ? 10 : 3; // 10 on Moonbeam, 3 on Alphanet
export const MOONBEAM_PARACHAIN_ID = CLUSTER === "mainnet" ? Polkachain.Moonbeam : Polkachain.MoonbaseAlpha;

export const getPolkaChains = () => {
  if (CLUSTER === "mainnet") {
    return POLKACHAIN.MAINNET;
  }
  return POLKACHAIN.TESTNET;
};

export const WORMHOLE_RPC_HOSTS: string[] =
  CLUSTER === "mainnet"
    ? [
        "https://api.wormholescan.io",
        "https://wormhole-v2-mainnet-api.mcf.rocks",
        "https://wormhole-v2-mainnet-api.chainlayer.network",
        "https://wormhole-v2-mainnet-api.staking.fund",
      ]
    : ["https://alpha.1rpc.io/wormhole"];

export const getBridgeChains = () => {
  if (CLUSTER === "mainnet") {
    return BRIDGE.MAINNET;
  }
  return BRIDGE.TESTNET;
};

export const ATA_SUPPORTED_CHAINS: ChainId[] = [CHAIN_ID_ETH, CHAIN_ID_POLYGON];

export const getChainIdsList = () => {
  const chains = getBridgeChains();
  return Object.values(chains).map((chainInfo) => chainInfo.chainId);
};

export const getChainEnum = (wormholeChain: number) => {
  switch (wormholeChain) {
    case CHAIN_ID_ETH:
      return BRIDGE_CHAINS.ETHEREUM;
    case CHAIN_ID_ACALA:
      return BRIDGE_CHAINS.ACALA;
    case CHAIN_ID_ARBITRUM:
      return BRIDGE_CHAINS.ARBITRUM;
    case CHAIN_ID_AURORA:
      return BRIDGE_CHAINS.AURORA;
    case CHAIN_ID_AVAX:
      return BRIDGE_CHAINS.AVAX;
    case CHAIN_ID_BSC:
      return BRIDGE_CHAINS.BINANCE;
    case CHAIN_ID_CELO:
      return BRIDGE_CHAINS.CELO;
    case CHAIN_ID_FANTOM:
      return BRIDGE_CHAINS.FANTOM;
    case CHAIN_ID_KARURA:
      return BRIDGE_CHAINS.KARURA;
    case CHAIN_ID_KLAYTN:
      return BRIDGE_CHAINS.KLAYTN;
    case CHAIN_ID_MOONBEAM:
      return BRIDGE_CHAINS.MOONBEAM;
    case CHAIN_ID_OASIS:
      return BRIDGE_CHAINS.OASIS;
    case CHAIN_ID_POLYGON:
      return BRIDGE_CHAINS.POLYGON;
    case CHAIN_ID_SOLANA:
      return BRIDGE_CHAINS.SOLANA;
    case CHAIN_ID_OPTIMISM:
      return BRIDGE_CHAINS.OPTIMISM;
    case CHAIN_ID_BASE:
      return BRIDGE_CHAINS.BASE;
    default:
      throw new Error("can't find chain enum");
  }
};

export class MetricsProvider extends ethers.providers.StaticJsonRpcProvider {
  chainId: ChainId | undefined;
  alive = true;
  pingRetry = 0;
  pingTimer: NodeJS.Timer | undefined;

  constructor(
    url?: string | ethers.utils.ConnectionInfo | undefined,
    network?: ethers.providers.Networkish | undefined,
  ) {
    super(url, network);

    // pingTimer will call ping every 60s to ensure the rpc is still alive
    this.pingTimer = setInterval(() => {
      this.ping();
    }, (120 + randomInt(0, 30)) * 1000);
  }

  // ping will call getBlockNumber and if it's failed, it will retry 3 times.
  // if all 3 retries failed, then it will mark the rpc as dead and do it next 60s
  async ping() {
    try {
      await super.getBlockNumber();

      this.markAsAlive();
      this.pingRetry = 0;
    } catch (e) {
      console.error(`[ChainId: ${this.chainId}] ping rpc failed. rpc: ${this.connection.url}, error: ${e}`);

      if (this.pingRetry < 3) {
        this.pingRetry += 1;
        this.ping();
      } else {
        this.markAsDead();
        this.pingRetry = 0;
      }
    }
  }

  markAsAlive() {
    console.log(`[ChainId: ${this.chainId}] rpc is alive: ${this.connection.url}`);
    this.alive = true;
  }

  markAsDead() {
    console.log(`[ChainId: ${this.chainId}] rpc is dead: ${this.connection.url}`);
    this.alive = false;
  }

  perform(method: string, parameters: any): Promise<any> {
    providerCountMonitor.labels({ chainId: this.chainId, method }).inc();

    const endLatencyTimer = providerLatencyMonitor.labels({ chainId: this.chainId, method }).startTimer();

    return super
      .perform(method, parameters)
      .catch((e) => {
        providerErrorCountMonitor.labels({ chainId: this.chainId, method }).inc();

        return e;
      })
      .finally(() => {
        endLatencyTimer();
      });
  }
}

export const getEVMProviderWithWormholeChain = (
  chainId: ChainId,
  startIndex?: number,
  endIndex?: number,
): MetricsProvider | undefined => {
  if (!isEVMChain(chainId)) {
    throw new Error("not an evm chain");
  }

  const allProviders = providers[chainId];

  if (allProviders) {
    const selectedProviders =
      startIndex != null || endIndex != null ? allProviders.slice(startIndex, endIndex) : allProviders;
    const aliveProviders = selectedProviders.filter((item) => item.alive);

    if (aliveProviders.length) {
      const randomAliveProviderIndex = randomInt(0, aliveProviders.length);

      return aliveProviders[randomAliveProviderIndex];
    } else {
      return undefined;
    }
  }

  const rpcUrls = getRPCUrlFromWormholeChain(chainId);
  const newProviders = rpcUrls.map((url) => new MetricsProvider({ url, timeout: 30 * 1000, throttleLimit: 1 })); //500ms timeout, no retry

  newProviders.forEach((provider) => {
    provider.chainId = chainId;
    provider.pollingInterval = 30 * 1000;
  });

  providers[chainId] = newProviders;

  const selectedProviders =
    startIndex != null || endIndex != null ? newProviders.slice(startIndex, endIndex) : newProviders;
  const randomNewProviderIndex = randomInt(0, selectedProviders.length);

  return selectedProviders[randomNewProviderIndex];
};

/**
 * get the rpc url given a specific wormhole chain ID
 * @param wormholeChain chain ID
 * @returns
 */
export const getRPCUrlFromWormholeChain = (wormholeChain: number) => {
  const chains = getBridgeChains();
  const chainEnumNum = getChainEnum(wormholeChain);
  return chains[BRIDGE_CHAINS[chainEnumNum] as keyof typeof BRIDGE_CHAINS].rpcUrls;
};

export const getChainInfoFromWormholeChain = (wormholeChain: number) => {
  const chains = getBridgeChains();
  const chainEnumNum = getChainEnum(wormholeChain);
  return chains[BRIDGE_CHAINS[chainEnumNum] as keyof typeof BRIDGE_CHAINS];
};

export const getClusterName = () => {
  return CLUSTER || "";
};

const tbtcConfigs: {
  [chainId: number]: { wtbtcAddress: string; tbtcAddress: string; gatewayAddress: string };
} =
  CLUSTER === "mainnet"
    ? {
        [CHAIN_ID_ETH]: {
          wtbtcAddress: "",
          tbtcAddress: "0x18084fbA666a33d37592fA2633fD49a74DD93a88",
          gatewayAddress: "",
        },
        [CHAIN_ID_POLYGON]: {
          wtbtcAddress: "0x3362b2b92b331925f09f9e5bca3e8c43921a435c",
          tbtcAddress: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",
          gatewayAddress: "0x09959798B95d00a3183d20FaC298E4594E599eab",
        },
        [CHAIN_ID_SOLANA]: {
          wtbtcAddress: "25rXTx9zDZcHyTav5sRqM6YBvTGu9pPH9yv83uAEqbgG",
          tbtcAddress: "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU",
          gatewayAddress: "87MEvHZCXE3ML5rrmh5uX1FbShHmRXXS32xJDGbQ7h5t",
        },
        [CHAIN_ID_ARBITRUM]: {
          wtbtcAddress: "0x57723abc582dbfe11ea01f1a1f48aee20bd65d73",
          tbtcAddress: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
          gatewayAddress: "0x1293a54e160D1cd7075487898d65266081A15458",
        },
        [CHAIN_ID_OPTIMISM]: {
          wtbtcAddress: "0xec0a755664271b87002dda33ca2484b24af68912",
          tbtcAddress: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
          gatewayAddress: "0x1293a54e160D1cd7075487898d65266081A15458",
        },
        [CHAIN_ID_BASE]: {
          wtbtcAddress: "0x9ee95e6bd1b3c5740f105d6fb06b8bdef64eec70",
          tbtcAddress: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
          gatewayAddress: "0x09959798b95d00a3183d20fac298e4594e599eab",
        },
      }
    : {
        [CHAIN_ID_ETH]: {
          wtbtcAddress: "",
          tbtcAddress: "0x679874fbe6d4e7cc54a59e315ff1eb266686a937",
          gatewayAddress: "",
        },
        [CHAIN_ID_POLYGON]: {
          wtbtcAddress: "0xf6CC0Cc8D54a4b1A63a0E9745663e0c844Ee4D48",
          tbtcAddress: "0xBcD7917282E529BAA6f232DdDc75F3901245A492",
          gatewayAddress: "0x91Fe7128f74dBd4F031ea3D90FC5Ea4DCfD81818",
        },
        [CHAIN_ID_SOLANA]: {
          wtbtcAddress: "FMYvcyMJJ22whB9m3T5g1oPKwM6jpLnFBXnrY6eXmCrp",
          tbtcAddress: "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU",
          gatewayAddress: "87MEvHZCXE3ML5rrmh5uX1FbShHmRXXS32xJDGbQ7h5t",
        },
        [CHAIN_ID_ARBITRUM]: {
          wtbtcAddress: "0x97B5fE27a82b2B187D9a19C5782d9eB93B82DaC3",
          tbtcAddress: "0x85727F4725A4B2834e00Db1AA8e1b843a188162F",
          gatewayAddress: "0x31A15e213B59E230b45e8c5c99dAFAc3d1236Ee2",
        },
        [CHAIN_ID_OPTIMISM]: {
          wtbtcAddress: "0x5d89a5bcb86f15a2ccab05e7e3bee23fdf246a64",
          tbtcAddress: "0x1a53759de2eadf73bd0b05c07a4f1f5b7912da3d",
          gatewayAddress: "0x6449f4381f3d63bdfb36b3bdc375724ad3cd4621",
        },
        [CHAIN_ID_BASE]: {
          wtbtcAddress: "0x0219441240d89fac3fd708d06d8fd3a072c02fb6",
          tbtcAddress: "0x783349cd20f26ce12e747b1a17bc38d252c9e119",
          gatewayAddress: "0xe3e0511eebd87f08fbae4486419cb5dfb06e1343",
        },
      };

export const getTBTCGatewayForChain = (id: ChainId) => {
  return tbtcConfigs[id]?.gatewayAddress || "";
};

export function getTBTCGatewayForChainOrError(id: ChainId, error: Error) {
  const gateway = getTBTCGatewayForChain(id);
  if (gateway) return gateway;
  throw error;
}

export const getTBTCAddressForChain = (id: ChainId) => {
  return tbtcConfigs[id]?.tbtcAddress || "";
};

export const getWtBTCAddressForChain = (id: ChainId) => {
  return tbtcConfigs[id]?.wtbtcAddress || "";
};

export const isTbtcEnabled = (id: ChainId) => {
  return tbtcConfigs[id]?.tbtcAddress != null;
};

export function isEVMChainEnabled(chainId: ChainId) {
  return process.env.ENABLED_EVM_CHAIN != null
    ? process.env.ENABLED_EVM_CHAIN.split(",").some((item) => parseInt(item) === chainId)
    : true;
}
