interface JSONObject {
  [k: string]: string;
}

export const TXN_STATUS: JSONObject = {
  PENDING: "pending",
  FAILED: "failed",
  CONFIRMED: "confirmed",
  REDEEMED: "redeemed",
};

export const TXN_TYPE: JSONObject = {
  TOKEN_BRIDGE: "token_bridge",
  NFT_BRIDGE: "nft_bridge",
  SWAP: "swap",
  REDEEM: "redeem",
  RECOVERY: "recovery",
};
