export interface ExtendedTokenIdentity extends BasicTokenIdentity {
  nft: boolean;
}

export interface BasicTokenIdentity {
  tokenAddress: string;
  chainId: number;
}
