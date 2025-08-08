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
                        const reply: string[] = [];

                        const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                        reply.push("Bitcoin RPC status:");
                        reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                        if(btcRpcStatus!=null) {
                            reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                            reply.push("    Synced headers: "+btcRpcStatus.headers);
                            reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                        }

                        const btcRelayStatus = await this.chainData.btcRelay.getTipData();
                        reply.push("Bitcoin on-chain light client status:");
                        reply.push("    Status: "+(btcRelayStatus==null ? "uninitialized" : "initialized"));
                        if(btcRelayStatus!=null) {
                            if (btcRpcStatus != null) {
                                reply.push("    Synced: " + (btcRelayStatus.blockheight === btcRpcStatus.blocks ? "yes" : "no"));
                            }
                            reply.push("    Blockheight: " + btcRelayStatus.blockheight);
                            reply.push("    Tip blockhash: " + btcRelayStatus.blockhash);
                            reply.push("    Commitment hash: " + btcRelayStatus.commitHash);
                        }

                        const balance = await this.chainData.swapContract.getBalance(
                            this.chainData.signer.getAddress(),
                            this.chainData.nativeToken, false
                        );
                        reply.push("Relayer status:");
                        reply.push("    Funds: " + toDecimal(balance, this.chainData.nativeTokenDecimals));

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the "+chainId+" address used to pay for the transaction fees",
                {
                    args: {},
                    parser: (args) => {
                        return Promise.resolve(this.chainData.signer.getAddress());
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
                        return toDecimal(balance, this.chainData.nativeTokenDecimals);
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
                        return "Transfer transaction confirmed! TxId: "+txIds[txIds.length-1];
                    }
                }
            )
        ], cliAddress, cliPort, "Welcome to atomiq BTC relay CLI for chain: "+chainId+"!", rpcConfig);
    }

    init() {
        return this.cmdHandler.init().then(() => super.init());
    }

}
