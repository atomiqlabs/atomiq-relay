import {
    CommandHandler,
    createCommand,
    toDecimal,
    fromDecimal,
    cmdStringParser,
    RpcConfig
} from "@atomiqlabs/server-base";
import {BtcRelayRunner} from "./BtcRelayRunner";
import {ChainType} from "@atomiqlabs/base";
import {ChainData} from "../chains/ChainInitializer";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";

export class BtcRelayRunnerWrapper<T extends ChainType> extends BtcRelayRunner<T> {

    cmdHandler: CommandHandler;

    constructor(
        directory: string,
        chainData: ChainData<T>,
        bitcoinRpc: BitcoindRpc,
        zmqHost: string,
        zmqPort: number,
        cliAddress: string,
        cliPort: number,
        rpcAddress?: string,
        rpcPort?: number
    ) {
        super(directory, chainData, bitcoinRpc, zmqHost, zmqPort);

        const chainId = this.chainData.chainId;

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
                        const btcRelayStatus = await this.chainData.btcRelay.getTipData();
                        const balance = await this.chainData.swapContract.getBalance(
                            this.chainData.signer.getAddress(),
                            this.chainData.nativeToken, false
                        );

                        return {
                            bitcoinRpc: {
                                status: btcRpcStatus == null ? "offline" : 
                                       btcRpcStatus.ibd ? "verifying blockchain" : "ready",
                                verificationProgress: btcRpcStatus?.verificationProgress ? 
                                    (btcRpcStatus.verificationProgress * 100).toFixed(4) + "%" : null,
                                syncedHeaders: btcRpcStatus?.headers || null,
                                syncedBlocks: btcRpcStatus?.blocks || null
                            },
                            bitcoinOnChainLightClient: {
                                status: btcRelayStatus == null ? "uninitialized" : "initialized",
                                synced: btcRpcStatus && btcRelayStatus ? 
                                    btcRelayStatus.blockheight === btcRpcStatus.blocks : null,
                                blockheight: btcRelayStatus?.blockheight || null,
                                tipBlockhash: btcRelayStatus?.blockhash || null,
                                commitmentHash: btcRelayStatus?.commitHash || null
                            },
                            relayer: {
                                funds: toDecimal(balance, this.chainData.nativeTokenDecimals)
                            }
                        };
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the "+chainId+" address used to pay for the transaction fees",
                {
                    args: {},
                    parser: (args) => {
                        return Promise.resolve({
                            chainId: chainId,
                            address: this.chainData.signer.getAddress()
                        });
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the "+chainId+" balance of the address used to pay for the transaction fees",
                {
                    args: {},
                    parser: async (args) => {
                        const balance = await this.chainData.swapContract.getBalance(
                            this.chainData.signer.getAddress(),
                            this.chainData.nativeToken, false
                        );
                        return {
                            chainId: chainId,
                            address: this.chainData.signer.getAddress(),
                            balance: toDecimal(balance, this.chainData.nativeTokenDecimals),
                        };
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfers "+chainId+" balance to an external address",
                {
                    args: {
                        address: {
                            base: true,
                            description: "Destination address of the "+chainId+" token",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Param needs to be provided!");
                                if(!this.chainData.chain.isValidAddress(data)) throw new Error("Not a valid "+chainId+" address!");
                                return data;
                            }
                        },
                        amount: {
                            base: true,
                            description: "Amount of the "+chainId+" tokens to send",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        const amount: bigint = fromDecimal(args.amount, this.chainData.nativeTokenDecimals);

                        const txns = await this.chainData.chain.txsTransfer(
                            this.chainData.signer.getAddress(),
                            this.chainData.nativeToken,
                            amount, args.address
                        );
                        const txIds = await this.chainData.chain.sendAndConfirm(
                            this.chainData.signer,
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
                            chainId: chainId,
                            from: this.chainData.signer.getAddress(),
                            to: args.address,
                            amount: args.amount,
                        };
                    }
                }
            )
        ], cliAddress, cliPort, "Welcome to atomiq BTC relay CLI for chain: "+chainId+"!", rpcConfig);
    }

    init() {
        return this.cmdHandler.init().then(() => super.init());
    }

}
