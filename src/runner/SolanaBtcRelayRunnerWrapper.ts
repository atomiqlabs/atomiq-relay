
import {ComputeBudgetProgram, Signer, Transaction, Keypair} from "@solana/web3.js";
import {AnchorProvider} from "@coral-xyz/anchor";
import {SolanaBtcRelay, SolanaBtcStoredHeader, SolanaFeeEstimator, SolanaSwapData, SolanaSwapProgram} from "crosslightning-solana";
import {BitcoindBlock, BitcoindRpc, BtcRelaySynchronizer} from "btcrelay-bitcoind";
import {Watchtower} from "btcrelay-watchtower";
import {BtcRelay, BtcSyncInfo, StorageObject, SwapContract} from "crosslightning-base";
import * as BN from "bn.js";
import {CommandHandler, createCommand, cmdNumberParser} from "crosslightning-server-base";
import {SolanaBtcRelayRunner} from "./SolanaBtcRelayRunner";
import {BtcRelayConfig} from "../BtcRelayConfig";

export class SolanaBtcRelayRunnerWrapper extends SolanaBtcRelayRunner {

    cmdHandler: CommandHandler;

    constructor(
        signer: (AnchorProvider & {signer: Keypair}),
        bitcoinRpc: BitcoindRpc,
        btcRelay: SolanaBtcRelay<BitcoindBlock>,
        zmqHost: string,
        zmqPort: number
    ) {
        super(signer, bitcoinRpc, btcRelay, zmqHost, zmqPort);
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

                        const btcRelayStatus = await this.btcRelay.getTipData();
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

                        const balance = await this.swapProgram.getBalance(this.swapProgram.getNativeCurrencyAddress(), false);
                        reply.push("Relayer status:");
                        reply.push("    Funds: " + (balance.toNumber()/Math.pow(10, 9)).toFixed(9));
                        reply.push("    Has enough funds (>0.1 SOL): " + (balance.gt(new BN(100000000)) ? "yes" : "no"));

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the Solana address used to pay for the transaction fees",
                {
                    args: {},
                    parser: (args) => {
                        return Promise.resolve(this.swapProgram.getAddress());
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the SOL balance of the address used to pay for the transaction fees",
                {
                    args: {},
                    parser: (args) => {
                        return this.swapProgram.getBalance(this.swapProgram.getNativeCurrencyAddress(), false).then(value => {
                            return (value.toNumber()/Math.pow(10, 9)).toFixed(9);
                        });
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfers SOL balance to an external address",
                {
                    args: {
                        address: {
                            base: true,
                            description: "Destination address of the SOL",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Param needs to be provided!");
                                if(!this.swapProgram.isValidAddress(data)) throw new Error("Not a valid Solana address!");
                                return data;
                            }
                        },
                        amount: {
                            base: true,
                            description: "Amount of the SOL to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const amount = new BN((args.amount*Math.pow(10, 9)).toFixed(0));

                        const txns = await this.swapProgram.txsTransfer(this.swapProgram.getNativeCurrencyAddress(), amount, args.address);
                        await this.swapProgram.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "airdrop",
                "Requests an airdrop of SOL tokens (only works on devnet!)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        let signature = await this.signer.connection.requestAirdrop(this.signer.publicKey, 1500000000);
                        sendLine("Transaction sent, signature: "+signature+" waiting for confirmation...");
                        const latestBlockhash = await this.signer.connection.getLatestBlockhash();
                        await this.signer.connection.confirmTransaction(
                            {
                                signature,
                                ...latestBlockhash,
                            },
                            "confirmed"
                        );
                        return "Airdrop transaction confirmed!";
                    }
                }
            )
        ], BtcRelayConfig.CLI.ADDRESS, BtcRelayConfig.CLI.PORT, "Welcome to atomiq BTC relay CLI!");
    }

    init() {
        return this.cmdHandler.init().then(() => super.init());
    }

}
