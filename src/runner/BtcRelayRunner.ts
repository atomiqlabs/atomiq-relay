import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";
import {
    BtcSyncInfo,
    ChainType,
    Messenger,
} from "@atomiqlabs/base";
import {ChainData} from "../chains/ChainInitializer";
import {SingleChainBtcRelayRunner} from "./SingleChainBtcRelayRunner";

export type BtcRelayStatus = "offline" | "awaiting_bitcoind" | "active";
export type WatchtowersEnabledType = {
    LEGACY_SWAPS?: boolean,
    SPV_SWAPS?: boolean,
    HTLC_SWAPS?: boolean
};

export class BtcRelayRunner {

    readonly bitcoinRpc: BitcoindRpc;
    readonly chainsData: {[chainId: string]: ChainData};
    readonly chainRelayRunners: {[chainId: string]: SingleChainBtcRelayRunner<ChainType>};

    readonly zmqHost: string;
    readonly zmqPort: number;

    status: BtcRelayStatus = "offline";

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
        enabledWatchtowers: WatchtowersEnabledType
    ) {
        this.bitcoinRpc = bitcoinRpc;
        this.zmqHost = zmqHost;
        this.zmqPort = zmqPort;

        this.chainsData = {};
        this.chainRelayRunners = {};

        for(let chainId in chainsData) {
            const chainData = chainsData[chainId];
            this.chainsData[chainId] = chainData.data;
            this.chainRelayRunners[chainId] = new SingleChainBtcRelayRunner<ChainType>(
                rootDirectory+"/"+chainId,
                chainData.data,
                bitcoinRpc,
                messenger,
                {...enabledWatchtowers, ...chainData.watchtowers}
            );
        }
    }

    syncToLatest() {
        for(let chainId in this.chainRelayRunners) {
            this.chainRelayRunners[chainId].syncToLatest();
        }
    }

    /**
     * Subscribes to new bitcoin blocks through ZMQ
     */
    async subscribeToNewBlocksZMQ() {
        const {Subscriber} = await import("zeromq");

        const listen = async () => {
            while(true) {
                const sock = new Subscriber({
                    receiveTimeout: 15*60*1000
                });
                sock.connect("tcp://"+this.zmqHost+":"+this.zmqPort);
                sock.subscribe("hashblock");

                while(true) {
                    try {
                        const [topic, msg] = await sock.receive();
                        const blockHash = msg.toString("hex");
                        console.log("subscribeToNewBlocksZMQ(): New blockhash: ", blockHash);
                        this.syncToLatest();
                    } catch (e) {
                        console.error(e);
                        console.log("subscribeToNewBlocksZMQ(): Error occurred in new block listener or no new block in 15 minutes, resubscribing in 10 seconds");
                        sock.close();
                        this.syncToLatest();
                        await new Promise(resolve => setTimeout(resolve, 10*1000));
                        break;
                    }
                }
            }
        }
        console.log("subscribeToNewBlocksZMQ(): Listening to new blocks...");
        listen();
    }

    async subscribeToNewBlocksPolling() {
        let latestBlockhash = await this.bitcoinRpc.getBlockhash(await this.bitcoinRpc.getTipHeight());

        const sync = async () => {
            const currentBlockhash = await this.bitcoinRpc.getBlockhash(await this.bitcoinRpc.getTipHeight());
            if(latestBlockhash===currentBlockhash) return;
            latestBlockhash = currentBlockhash;

            console.log("subscribeToNewBlocksPolling(): Syncing...");
            try {
                this.syncToLatest();
            } catch (e) {
                console.error(e);
            }
        }

        let func: () => void;
        func = () => {
            sync().then(() => {
                setTimeout(func.bind(this), 5*1000);
            });
        }

        func();
    }

    async subscribeToNewBlocks() {
        try {
            await this.subscribeToNewBlocksZMQ();
            console.log("subscribeToNewBlocks(): Successfully subscribed to new blocks via ZMQ!");
        } catch (err) {
            console.error("subscribeToNewBlocks(): Cannot subscribe to new blocks using ZMQ: ", err);
            console.log("subscribeToNewBlocks(): Failed to subscribe via ZMQ, falling back to polling!");
            await this.subscribeToNewBlocksPolling();
        }
    }

    /**
     * Checks if IBD on the bitcoind has finished yet
     */
    async waitForBitcoinRpc() {
        console.log("waitForBitcoinRpc(): Waiting for bitcoin RPC...");
        let rpcState: BtcSyncInfo = null;
        while(rpcState==null || rpcState.ibd) {
            rpcState = await this.bitcoinRpc.getSyncInfo().catch(e => {
                console.error(e);
                return null;
            });
            console.log("waitForBitcoinRpc(): Bitcoin RPC state: ", rpcState==null ? "offline" : rpcState.ibd ? "IBD" : "ready");
            if(rpcState==null || rpcState.ibd) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("waitForBitcoinRpc(): Bitcoin RPC ready, continue");
    }

    async init() {
        this.status = "awaiting_bitcoind";

        await this.waitForBitcoinRpc();

        this.status = "active";

        await this.subscribeToNewBlocks();

        await Promise.all(
            Object.keys(this.chainRelayRunners).map(chainId => this.chainRelayRunners[chainId].init())
        );
    }

}
