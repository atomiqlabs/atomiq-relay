import {
    CommandHandler,
    createCommand,
    toDecimal,
    fromDecimal,
    cmdStringParser,
    RpcConfig,
    TcpCliConfig, cmdEnumParser
} from "@atomiqlabs/server-base";
import {BtcRelayRunner, WatchtowersEnabledType} from "./BtcRelayRunner";
import {ChainType, Messenger} from "@atomiqlabs/base";
import {ChainData} from "../chains/ChainInitializer";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";

export class BtcRelayRunnerWrapper extends BtcRelayRunner {

    cmdHandler: CommandHandler;

    constructor(
        rootDirectory: string,
        chainsData: {
            [chainId: string]: {
                data: ChainData,
                watchtowers: WatchtowersEnabledType
            }
        },
        bitcoinRpc: BitcoindRpc,
        zmqHost: string,
        zmqPort: number,
        messenger: Messenger,
        enabledWatchtowers: WatchtowersEnabledType,
        cliAddress: string,
        cliPort: number,
        rpcAddress?: string,
        rpcPort?: number
    ) {
        super(rootDirectory, chainsData, bitcoinRpc, zmqHost, zmqPort, messenger, enabledWatchtowers);

        // Create TCP CLI config
        const tcpCliConfig: TcpCliConfig = {
            address: cliAddress,
            port: cliPort,
            introMessage: "Welcome to atomiq BTC relay CLI!"
        };

        // Create RPC config if RPC parameters are provided
        const rpcConfig: RpcConfig | undefined = rpcAddress && rpcPort ? {
            address: rpcAddress,
            port: rpcPort
        } : undefined;

        this.cmdHandler = new CommandHandler([
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, on-chain light client & relayer application",
                {
                    args: {},
                    parser: async (args) => {
                        const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);

                        const chains = {};
                        for(let chainId in this.chainsData) {
                            const chainData = this.chainsData[chainId];

                            const btcRelayStatus = await chainData.btcRelay.getTipData();
                            const balance = await chainData.chain.getBalance(
                                chainData.signer.getAddress(),
                                chainData.nativeToken
                            );

                            chains[chainId] = {
                                status: this.chainRelayRunners[chainId]?.status ?? "inactive",
                                funds: toDecimal(balance, chainData.nativeTokenDecimals),
                                bitcoinLightClient: {
                                    status: btcRelayStatus == null ? "uninitialized" : "initialized",
                                    synced: btcRpcStatus && btcRelayStatus ?
                                        btcRelayStatus.blockheight === btcRpcStatus.blocks : null,
                                    blockheight: btcRelayStatus?.blockheight || null,
                                    tipBlockhash: btcRelayStatus?.blockhash || null,
                                    commitmentHash: btcRelayStatus?.commitHash || null
                                },
                            };
                        }

                        return {
                            bitcoinRpc: {
                                status: btcRpcStatus == null ? "offline" : 
                                       btcRpcStatus.ibd ? "verifying blockchain" : "ready",
                                verificationProgress: btcRpcStatus?.verificationProgress ? 
                                    (btcRpcStatus.verificationProgress * 100).toFixed(4) + "%" : null,
                                syncedHeaders: btcRpcStatus?.headers || null,
                                syncedBlocks: btcRpcStatus?.blocks || null
                            },
                            status: this.status,
                            chains
                        };
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the address used to pay for the transaction fees",
                {
                    args: {
                        chainId: {
                            base: true,
                            description: "Chain identifier for which to get the address for",
                            parser: cmdEnumParser<string>(Object.keys(this.chainsData))
                        }
                    },
                    parser: (args) => {
                        const chainData = this.chainsData[args.chainId];
                        if(chainData==null) throw new Error(`Unknown chain ${args.chainId}`);

                        return Promise.resolve({
                            chainId: args.chainId,
                            address: chainData.signer.getAddress()
                        });
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balance of the address used to pay for the transaction fees",
                {
                    args: {
                        chainId: {
                            base: true,
                            description: "Chain identifier for which to get the balance for",
                            parser: cmdEnumParser<string>(Object.keys(this.chainsData))
                        }
                    },
                    parser: async (args) => {
                        const chainData = this.chainsData[args.chainId];
                        if(chainData==null) throw new Error(`Unknown chain ${args.chainId}`);

                        const balance = await chainData.swapContract.getBalance(
                            chainData.signer.getAddress(),
                            chainData.nativeToken, false
                        );
                        return {
                            chainId: args.chainId,
                            address: chainData.signer.getAddress(),
                            balance: toDecimal(balance, chainData.nativeTokenDecimals),
                        };
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfers wallet balance to an external address",
                {
                    args: {
                        chainId: {
                            base: true,
                            description: "Chain identifier for which to get the balance for",
                            parser: cmdEnumParser<string>(Object.keys(this.chainsData))
                        },
                        address: {
                            base: true,
                            description: "Destination address of the token",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the tokens to send",
                            parser: cmdStringParser()
                        },
                        token: {
                            base: false,
                            description: "Address of the token to send, if specified the amount must be set in base units (not decimal, like for native token)",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        const chainData = this.chainsData[args.chainId];
                        if(chainData==null) throw new Error(`Unknown chain ${args.chainId}`);
                        if(!chainData.chain.isValidAddress(args.address)) throw new Error(`Not a valid ${args.chainId} address!`)

                        let tokenAddress: string;
                        let amount: bigint;
                        if(args.token!=null) {
                            if(!chainData.chain.isValidToken(args.token)) throw new Error(`Not a valid ${args.chainId} token!`)
                            amount = BigInt(args.amount);
                            tokenAddress = args.token;
                        } else {
                            amount = fromDecimal(args.amount, chainData.nativeTokenDecimals);
                            tokenAddress = chainData.nativeToken;
                        }

                        const txns = await chainData.chain.txsTransfer(
                            chainData.signer.getAddress(),
                            tokenAddress,
                            amount, args.address
                        );
                        const txIds = await chainData.chain.sendAndConfirm(
                            chainData.signer,
                            txns, true, null, null,
                            (txId: string) => {
                                sendLine("Transaction sent, txId: "+txId+" waiting for confirmation...");
                                return Promise.resolve();
                            }
                        );
                        return {
                            message: "Transfer transaction confirmed!",
                            success: true,
                            transactionId: txIds[txIds.length-1],
                            chainId: args.chainId,
                            from: chainData.signer.getAddress(),
                            to: args.address,
                            amount: args.amount,
                        };
                    }
                }
            )
        ], tcpCliConfig, rpcConfig);
    }

    init() {
        return this.cmdHandler.init().then(() => super.init());
    }

}
