# Carrier Indexer

This is a backend service for Carrier project.

It is still work-in-progress, so the implementation may change along the way.

## Architecture

```
Carrier (frontend) -> REST_API -> Indexer -> MongoDB Atlas
```

The indexer has 3 parts:

**(1)** A REST API server for Carrier UI to query for transaction history.

**(2)** A subscriber script that listens for transaction events on wormhole token/NFT bridge, wormhole's contract and record them onto the database. The transaction status is set to `pending`.

**(3)** A cron-job that runs every 30 seconds and grabs all the pending transactions from (2), polls for the VAA from wormhole guardian server. If a VAA is present, the VAA is updated in the database and the transaction status is set to `confirmed`.

## How to run on local machine

Create a `.env` file in the root folder with the following testing credentials

```
CLUSTER="mainnet" // change this to testnet to listen for testnet
MONGODB_MAINNET_ATLAS_URI="mongodb+srv://dbuser:Tv8y35dxO1NZINcG@cluster0.3mpkpmr.mongodb.net/mainnet?retryWrites=true&w=majority"
MONGODB_TESTNET_ATLAS_URI="mongodb+srv://dbuser:Tv8y35dxO1NZINcG@cluster0.3mpkpmr.mongodb.net/testnet?retryWrites=true&w=majority"
TXN_TIMEOUT=2880
BACKEND_PORT=27001
```

1. Open a terminal and run:

```
npm run subscribe
```

This runs the subscriber script that listen for contract events.

2. Open another terminal and run:

```
npm run poll-vaa
```

This runs the cron-job that polls the VAA.

3. Open another terminal and run:

```
npm run api-server
```

This runs the REST API server for Carrier UI.

## Project Structure

`src/indexer`: contains the Indexer class that subscribes for events and a poll vaa cron-job.

`src/bridge.ts`: constants file that contain the bridge addresses, urls etc

`src/database`: MongoDB model schema

`src/subscriber.ts`: Invokes the Indexer class to subscribe to events.

`src/server`: REST API service

## Database Schema

### Transaction Model

Records the transaction details

```
    txnType: string;                        // token_bridge, nft_bridge, redeem, swap
    txn: string;                            // hash
    sender: string;                         // original sender; the user wallet that invoke the contract
    recipient: string;                      // target recipient; the wallet that the user which to transfer to
    tokenId?: string;                       // for nft
    tokenAmt: string;                       // token amount should be a normalized value and not native decimals, see wormhole Bridge.sol normalizeAmount
    swapInAmt?: string;                     // for swap
    swapOutAmt?: string;                    // for swap
    isSourceNative?: boolean;               // track if source is native currency, e.g. ETH, POLY
    arbiterFee?: string;                    // for token bridge; normalized value like tokenAmt; used by relayer
    unwrappedSourceTokenAddress?: string;   // for bridge; when transfer from source, the wormhole event will output tokenAddress and tokenChain, these two values might be generated if the source is wormhole wrapped
    unwrappedSourceChainId?: number;        // for bridge; if the source token is wrapped, wormhole will unwrapped it automatically and output it as a event param tokenChain.
    sourceTokenAddress: string;             // original token address that the user send
    sourceChainId: number;                  // original source chain ID that that user send from
    destTokenAddress: string;
    destChainId: number;
    wormholeSequence: string;               // to poll the vaa
    twoFASequence?: string;                 // for nft, to poll the vaa
    emitterAddress: string;                 // usually is wormhole token/NFT address
    twoFAEmitterAddress?: string;           // for nft; usually is ATA contract address
    signedVAABytes?: string;                // signed VAA from wormhole; record for recovery purpose
    signedVAAHash?: string;                 // signed VAA from wormhole; used to "link" redeem txn hash to this source transaction
    twoFASignedVAABytes?: string;           // for nft; not needed at all as we can query given the twoFAEmitterAddress and twoFASequence
    redeemTxn?: string;                     // if user/relayer has redeemed, the redeem txn hash is recorded at the source txn object
    status: string;                         // pending, confirmed, failed
    created: Date,
    updated: Date,
```

### Token Model

Records token information when user transfer.
Used by UI to query for decimals places to denormalize the amount and display the token symbol.

```
    tokenAddress: string,
    name: string,
    symbol: string,
    chainId: number,
    decimals?: number,
    created: Date,
    updated: Date,
```

### Asset Registered Model

Not used for now. This is only used for token bridge in ATA contracts as the users need to register their tokens if it is not on wormhole yet. Record just in case we need the info in the future.

```
    txn: string;
    asset: string;          // token address
    wrappedAsset: string;   // wrapped token address
    created: Date,
    updated: Date,
```

## Index EVM transactions manually

In the event of transactions that have been missed out due to RPC errors or some other reasons.

Invoke the following command to re-index the transactions.

```
# To index only a particular block
npm run index-evm-block [wormhole-chain-id] [startblock]

# To index a range of blocks
npm run index-evm-block [wormhole-chain-id] [startblock] [endblock]
```

## API

You may import the the postman file in `postman/indexer.postman_collection.json`.

### Pagination

The "transactions" api calls are all paginated, i.e. if you don't specify any page, they default to the first page.
If you need the next page, call the api with `?page=N`, e.g. `/api/v1/transactions/:chainId/:walletAddress?page=10` to see the results on the "9th page". Page number starts from 0.

### Get transactions of a wallet by chain

#### `GET /api/v1/transactions/:chainId/:walletAddress`

**Path Param: `chainId`**: Wormhole chain ID not the real one.

**Path Param: `walletAddress`**: 0xBase16 wallet address

<details>
    <summary><b>Sample Response</b></summary>

    {
        "msg": "success",
        "results": {
            "counts": 3,
            "limit": 10,
            "current": 0,
            "pages": 1,
            "previous": null,
            "next": null,
            "transactions": [
                {
                    "txn": "0xfc68744abab400b3fd0215f438fbba7fde9f11c49d74bfc3652fcd810c64061f",
                    "created": "2022-12-07T03:30:48.761Z",
                    "destChainId": 5,
                    "emitterAddress": "0x6ffd7ede62328b3af38fcd61461bbfc52f5651fe",
                    "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sourceChainId": 2,
                    "sourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "status": "confirmed",
                    "tokenId": "18",
                    "twoFAEmitterAddress": "0xcead6209cc1111547048893fc7dbbe89f13130a2",
                    "twoFASequence": "23",
                    "txnType": "nft_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "updated": "2022-12-07T03:31:01.220Z",
                    "wormholeSequence": "707"
                },
                {
                    "txn": "0xe03116437ea7a46b4a6cec6f70bda3438a255cef749f5b3cbabb01e77234d39d",
                    "created": "2022-12-07T00:54:47.909Z",
                    "destChainId": 5,
                    "emitterAddress": "0x6ffd7ede62328b3af38fcd61461bbfc52f5651fe",
                    "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sourceChainId": 2,
                    "sourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "status": "confirmed",
                    "tokenId": "17",
                    "twoFAEmitterAddress": "0xcead6209cc1111547048893fc7dbbe89f13130a2",
                    "twoFASequence": "22",
                    "txnType": "nft_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "updated": "2022-12-07T00:55:01.060Z",
                    "wormholeSequence": "706"
                },
                {
                    "txn": "0xb7cfed4bb95e41f627363e77461739a7b74977f93558349bfb4a0a1722195457",
                    "arbiterFee": "0",
                    "created": "2022-12-07T00:52:05.691Z",
                    "destChainId": 5,
                    "emitterAddress": "0x3ee18b2214aff97000d974cf647e7c347e8fa585",
                    "isSourceNative": true,
                    "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sourceChainId": 2,
                    "sourceTokenAddress": "0x0000000000000000000000000000000000000000",
                    "status": "confirmed",
                    "tokenAmt": "1000000000",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "updated": "2022-12-07T00:53:32.106Z",
                    "wormholeSequence": "86514"
                }
            ]
        }
    }

</details>

### Get all transactions

#### `GET /api/v1/transactions`

Returns ALL the transactions in the database. If you need to query for a specific transaction, sender, recipient, you can use filters in your queries. e.g. `/api/v1/transactions?txn=<txn_hash>&sender=<0x_wallet_address>`. This would return all transactions which matches the transaction hash **OR** those whose sender matches the provided wallet address. The filter is mainly used as a search function for the Carrier UI. For a full list of what can be filtered, see `controller.ts > getAllTransactions()`

<details>
    <summary><b>Sample Response</b></summary>

    {
        "msg": "success",
        "results": {
            "counts": 11,
            "limit": 10,
            "current": 0,
            "pages": 2,
            "previous": null,
            "next": 1,
            "transactions": [
                {
                    "txn": "0x6e276f26864826ccf91617e7d5a84120d5840cca98b9fae93b28c633682c266e",
                    "arbiterFee": "1",
                    "created": "2022-12-07T04:11:51.881Z",
                    "destChainId": 2,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": true,
                    "recipient": "0x7b96d90f7932eb59299fb5df0a682f629e902a56",
                    "sender": "0x7b96d90f7932eb59299fb5df0a682f629e902a56",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0x0000000000000000000000000000000000000000",
                    "status": "confirmed",
                    "tokenAmt": "16300285",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 4,
                    "unwrappedSourceTokenAddress": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
                    "updated": "2022-12-07T04:12:01.105Z",
                    "wormholeSequence": "221413"
                },
                {
                    "txn": "0xc9f1ddea7b85b3b01af508a897a0dce25aa0e7e28cd93a110517af0b3c2f37e2",
                    "arbiterFee": "0",
                    "created": "2022-12-07T04:08:15.752Z",
                    "destChainId": 1,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": false,
                    "recipient": "0xab6857afabe41e1e0f1c02627508b301083079ee7419cc7c8ce4e957bc15630b",
                    "sender": "0x89c3349b73dddecfff03c39ee9cbdaeb22cac604",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0xfafd4cb703b25cb22f43d017e7e0d75febc26743",
                    "status": "confirmed",
                    "tokenAmt": "1721968267198",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 4,
                    "unwrappedSourceTokenAddress": "0xfafd4cb703b25cb22f43d017e7e0d75febc26743",
                    "updated": "2022-12-07T04:08:31.084Z",
                    "wormholeSequence": "221412"
                },
                {
                    "txn": "0xde6560a44900c3258bd0d137cdfe8681361c86e320ea11fd8d482f23011639dc",
                    "arbiterFee": "0",
                    "created": "2022-12-07T04:05:43.758Z",
                    "destChainId": 2,
                    "emitterAddress": "0x0e082f06ff657d94310cb8ce8b0d9a04541d8052",
                    "isSourceNative": false,
                    "recipient": "0xf68ed8a68f5c388b0b07f8ea57e4f94ac41f707c",
                    "sender": "0xf68ed8a68f5c388b0b07f8ea57e4f94ac41f707c",
                    "sourceChainId": 6,
                    "sourceTokenAddress": "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664",
                    "status": "confirmed",
                    "tokenAmt": "69982477",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 6,
                    "unwrappedSourceTokenAddress": "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664",
                    "updated": "2022-12-07T04:06:01.634Z",
                    "wormholeSequence": "89705"
                },
                {
                    "txn": "0x0f91a5d94008d7e7c957cd61860d975afbf34020eee920800c4b0ee69a12e17d",
                    "arbiterFee": "0",
                    "created": "2022-12-07T03:53:07.573Z",
                    "destChainId": 22,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": false,
                    "recipient": "0x0000000000000000000000000000000000000000",
                    "sender": "0x7bc4dc490903e046aec4303f03599dd6fd06851a",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0x0000000000000000000000000000000000000000",
                    "status": "confirmed",
                    "tokenAmt": "100777564",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                    "updated": "2022-12-07T03:53:31.057Z",
                    "wormholeSequence": "221411"
                },
                {
                    "txn": "0x7064fa57051a194575bbb1bc57203c32d78d16517e051b19771b607984ec4a67",
                    "arbiterFee": "0",
                    "created": "2022-12-07T03:52:39.704Z",
                    "destChainId": 1,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": false,
                    "recipient": "0xa2c5a1925041aaa914912344a7f96c8e92d7ab606821ef9ade053bfb89399b46",
                    "sender": "0x7582bd1ce6692941caa9589702a6beb0be12885b",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0x55d398326f99059ff775485246999027b3197955",
                    "status": "confirmed",
                    "tokenAmt": "500000000000",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 4,
                    "unwrappedSourceTokenAddress": "0x55d398326f99059ff775485246999027b3197955",
                    "updated": "2022-12-07T03:53:01.480Z",
                    "wormholeSequence": "221410"
                },
                {
                    "txn": "0x0f393bea8990e477cddf701b4e6503965dc7fcce97c94ea3fb17e4e7a8e895c2",
                    "arbiterFee": "0",
                    "created": "2022-12-07T03:33:55.749Z",
                    "destChainId": 2,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": false,
                    "recipient": "0xe8cd49bd45db93e80c995e9eea06106896aaf290",
                    "sender": "0xe8cd49bd45db93e80c995e9eea06106896aaf290",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0xb6c53431608e626ac81a9776ac3e999c5556717c",
                    "status": "confirmed",
                    "tokenAmt": "583207119",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 4,
                    "unwrappedSourceTokenAddress": "0xb6c53431608e626ac81a9776ac3e999c5556717c",
                    "updated": "2022-12-07T03:34:01.045Z",
                    "wormholeSequence": "221409"
                },
                {
                    "txn": "0xfcd35109901ab258aedb6bd7cdc2c79d58ceca0db2aee1343e00ee5b307a7651",
                    "arbiterFee": "54580899",
                    "created": "2022-12-07T03:33:07.451Z",
                    "destChainId": 5,
                    "emitterAddress": "0xb6f6d86a8f9879a9c87f643768d9efc38c1da6e7",
                    "isSourceNative": false,
                    "recipient": "0x1f6e68690bf12efba9bac90d9db0067b8e8e0c0a",
                    "sender": "0x1f6e68690bf12efba9bac90d9db0067b8e8e0c0a",
                    "sourceChainId": 4,
                    "sourceTokenAddress": "0xc836d8dc361e44dbe64c4862d55ba041f88ddd39",
                    "status": "confirmed",
                    "tokenAmt": "109162810",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 5,
                    "unwrappedSourceTokenAddress": "0xd500b1d8e8ef31e21c99d1db9a6444d3adf1270",
                    "updated": "2022-12-07T03:33:31.089Z",
                    "wormholeSequence": "221408"
                },
                {
                    "txn": "0xfc68744abab400b3fd0215f438fbba7fde9f11c49d74bfc3652fcd810c64061f",
                    "created": "2022-12-07T03:30:48.761Z",
                    "destChainId": 5,
                    "emitterAddress": "0x6ffd7ede62328b3af38fcd61461bbfc52f5651fe",
                    "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sourceChainId": 2,
                    "sourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "status": "confirmed",
                    "tokenId": "18",
                    "twoFAEmitterAddress": "0xcead6209cc1111547048893fc7dbbe89f13130a2",
                    "twoFASequence": "23",
                    "txnType": "nft_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "updated": "2022-12-07T03:31:01.220Z",
                    "wormholeSequence": "707"
                },
                {
                    "txn": "0x4d28032595d7e2ad42dcd2cda7fc7db3dd6ce3578b735da4b5048607994972df",
                    "arbiterFee": "0",
                    "created": "2022-12-07T03:22:16.628Z",
                    "destChainId": 10,
                    "emitterAddress": "0x0e082f06ff657d94310cb8ce8b0d9a04541d8052",
                    "isSourceNative": false,
                    "recipient": "0x94d7c696377d0bfcf65257e8ea85402d2aef16d8",
                    "sender": "0x94d7c696377d0bfcf65257e8ea85402d2aef16d8",
                    "sourceChainId": 6,
                    "sourceTokenAddress": "0x9c540dd7591793738e61ba51fab162c2e0dd541f",
                    "status": "confirmed",
                    "tokenAmt": "21704946",
                    "txnType": "token_bridge",
                    "unwrappedSourceChainId": 10,
                    "unwrappedSourceTokenAddress": "0x4068da6c83afcfa0e13ba15a6696662335d5b75",
                    "updated": "2022-12-07T03:22:31.802Z",
                    "wormholeSequence": "89704"
                },
                {
                    "txn": "0xe03116437ea7a46b4a6cec6f70bda3438a255cef749f5b3cbabb01e77234d39d",
                    "created": "2022-12-07T00:54:47.909Z",
                    "destChainId": 5,
                    "emitterAddress": "0x6ffd7ede62328b3af38fcd61461bbfc52f5651fe",
                    "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                    "sourceChainId": 2,
                    "sourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "status": "confirmed",
                    "tokenId": "17",
                    "twoFAEmitterAddress": "0xcead6209cc1111547048893fc7dbbe89f13130a2",
                    "twoFASequence": "22",
                    "txnType": "nft_bridge",
                    "unwrappedSourceChainId": 2,
                    "unwrappedSourceTokenAddress": "0x076c0482a1814b1e97fd2e6742f1ab4c87c6e36b",
                    "updated": "2022-12-07T00:55:01.060Z",
                    "wormholeSequence": "706"
                }
            ]
        }
    }

</details>

### Get all redeem transactions

#### `GET /api/v1/redeems`

Get redeem transactions.

<details>
    <summary><b>Sample Response</b></summary>
    
    {
        "msg": "success",
        "results": [
            {
                "txn": "0x7edd6128fb6fa3604161b505b95ff46db31681f008d759e17482f4d277af7a5a",
                "created": "2022-12-07T03:32:11.145Z",
                "destChainId": 5,
                "destTokenAddress": "0xe6e91cbffb648be81d893c272e8e35b62d75df5e",
                "recipient": "0xd846b447b80174e908b9288af81428a8d60f456b",
                "sender": "0xd846b447b80174e908b9288af81428a8d60f456b",
                "status": "confirmed",
                "tokenId": "18",
                "txnType": "redeem",
                "unwrappedSourceChainId": 2,
                "unwrappedSourceTokenAddress": "0xe6e91cbffb648be81d893c272e8e35b62d75df5e",
                "updated": "2022-12-07T03:32:11.145Z"
            },
            {
                "txn": "0x6994d2603cc45a58b862be01ca1fbf68886152bee30e547ce7a41d1e4a16db0e",
                "created": "2022-12-06T11:58:37.883Z",
                "destChainId": 5,
                "destTokenAddress": "0x11cd37bb86f65419713f30673a480ea33c826872",
                "recipient": "0xb6663330bab2a7c07ffb6d6b2b4acd0378aec483",
                "sender": "0xb6663330bab2a7c07ffb6d6b2b4acd0378aec483",
                "status": "confirmed",
                "tokenAmt": "500000000000000000",
                "txnType": "redeem",
                "unwrappedSourceChainId": 2,
                "unwrappedSourceTokenAddress": "0x11cd37bb86f65419713f30673a480ea33c826872",
                "updated": "2022-12-06T11:58:37.883Z"
            }
        ]
    }
</details>

### Get token info by token address

#### `GET /api/v1/tokens/:tokenAddress`

**Path Param: `tokenAddress`**: 0xBase16 wallet address

Get the token information (name, symbol, decimals). Note that because token address may be identical on different chains.
If you want a more precise call, please use the next one.

<details>
    <summary><b>Sample Response</b></summary>

    {
        "msg": "success",
        "results": {
            "tokenAddress": "F6d4we2yt9DxPwYbo18YG4bGDxMFpghQcgYWsoJTmtia",
            "name": "USDT Token (Wormhole)",
            "symbol": "USDT",
            "decimals": 8,
            "created": "2022-12-16T05:11:02.510Z",
            "updated": "2022-12-16T05:11:02.510Z",
            "chainId": 1
        }
    }

</details>

### Get token info by token address with specific chain id

#### `GET /api/v1/tokens/:chainId/:tokenAddress`

**Path Param: `chainId`**: Wormhole chain ID not the real one.

**Path Param: `tokenAddress`**: 0xBase16 wallet address

Get the token information (name, symbol, decimals).

<details>
    <summary><b>Sample Response</b></summary>

    {
        "msg": "success",
        "results": {
            "tokenAddress": "F6d4we2yt9DxPwYbo18YG4bGDxMFpghQcgYWsoJTmtia",
            "name": "USDT Token (Wormhole)",
            "symbol": "USDT",
            "decimals": 8,
            "created": "2022-12-16T05:11:02.510Z",
            "updated": "2022-12-16T05:11:02.510Z",
            "chainId": 1
        }
    }

</details>

## Known Issues

Sometimes the subscriber script may display `MongoNotConnectedError: Client must be connected before running operations` error, this might be the case as we are using a free Atlas plan. The transactions would still be written into the database.

## Dockerized (Outdated)

At the root folder:

```
docker build -t bridge-indexer .
docker run -dp 27001:27001 bridge-indexer
```
