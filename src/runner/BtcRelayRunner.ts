import {StorageManager} from "../storagemanager/StorageManager";

import {Subscriber} from "zeromq";
import {BitcoindRpc, BtcRelaySynchronizer} from "@atomiqlabs/btc-bitcoind";
import {BtcRelayWatchtower, HashlockSavedWatchtower, WatchtowerClaimTxType} from "@atomiqlabs/watchtower-lib";
import {
    BtcSyncInfo,
    ChainType,
    Messenger,
    StorageObject,
} from "@atomiqlabs/base";
import {ChainData} from "../chains/ChainInitializer";

class NumberStorage implements StorageObject {

    num: number;

    constructor(num: number);
    constructor(data: any);

    constructor(dataOrNum: number | any) {
        if(typeof(dataOrNum)==="number") {
            this.num = dataOrNum;
        } else {
            this.num = dataOrNum.num;
        }
    }

    serialize(): any {
        return {
            num: this.num
        }
    }

}

const KEY: string = "FORK";
const MAX_BATCH_CLAIMS: number = 15;

export class BtcRelayRunner<T extends ChainType> {

    readonly storageManager: StorageManager<NumberStorage>;
    readonly bitcoinRpc: BitcoindRpc;
    readonly synchronizer: BtcRelaySynchronizer<any, T["TX"]>;
    readonly watchtower: BtcRelayWatchtower<T, any>;
    readonly hashlockWatchtower: HashlockSavedWatchtower<T>;
    readonly chainData: ChainData<T>;

    readonly zmqHost: string;
    readonly zmqPort: number;

    lastForkId: number;

    constructor(
        directory: string,
        chainData: ChainData<T>,
        bitcoinRpc: BitcoindRpc,
        zmqHost: string,
        zmqPort: number,
        messenger: Messenger,
        enabledWatchtowers?: {
            LEGACY_SWAPS?: boolean,
            SPV_SWAPS?: boolean,
            HTLC_SWAPS?: boolean
        }
    ) {
        this.chainData = chainData;
        this.bitcoinRpc = bitcoinRpc;
        this.zmqHost = zmqHost;
        this.zmqPort = zmqPort;

        this.storageManager = new StorageManager<NumberStorage>(directory+"/forkData");

        this.synchronizer = new BtcRelaySynchronizer(this.chainData.btcRelay, bitcoinRpc);

        if(enabledWatchtowers?.LEGACY_SWAPS || enabledWatchtowers?.SPV_SWAPS) this.watchtower = new BtcRelayWatchtower<T, any>(
            new StorageManager(directory+"/wt"),
            new StorageManager(directory+"/spvvaults"),
            directory+"/wt-height.txt",
            this.chainData.btcRelay,
            this.chainData.chainEvents,
            enabledWatchtowers?.LEGACY_SWAPS ? this.chainData.swapContract : null,
            enabledWatchtowers?.SPV_SWAPS ? this.chainData.spvVaultContract : null,
            this.chainData.spvVaultDataCtor,
            this.chainData.signer,
            bitcoinRpc,
            30,
            this.chainData.shouldClaimCbk
        );
        if(enabledWatchtowers?.HTLC_SWAPS) this.hashlockWatchtower = new HashlockSavedWatchtower(
            new StorageManager(directory+"/hashlockWt"),
            messenger,
            this.chainData.chainEvents,
            this.chainData.swapContract,
            this.chainData.swapDataClass,
            this.chainData.signer,
            this.chainData.shouldClaimCbk
        )
    }

    /**
     * Tries to sweep/delete existing fork data accounts
     */
    async trySweepForkData() {
        if(this.chainData.btcRelay.sweepForkData!=null) {
            try {
                console.log("[Main]: Run sweep fork accounts, last swept: ", this.lastForkId);
                const newForkId = await this.chainData.btcRelay.sweepForkData(this.chainData.signer, this.lastForkId);
                if(newForkId!=null && newForkId!==this.lastForkId) {
                    await this.storageManager.saveData(KEY, new NumberStorage(newForkId));
                    this.lastForkId = newForkId;
                }
                console.log("[Main]: Run sweep fork success, new last swept: ", newForkId);
            } catch (e) {
                console.error(e);
            }
        }
    }

    /**
     * Syncs the BTC relay to the latest tip block, claiming PTLCs along the way
     */
    async syncToLatest() {
        console.log("[Main]: Syncing to latest...");
        const resp = await this.synchronizer.syncToLatestTxs(this.chainData.signer.getAddress());

        const nBlocks = Object.keys(resp.blockHeaderMap).length-1;
        console.log("[Main]: Synchronizing blocks: ", nBlocks);
        console.log("[Main]: Synchronizing blocks in # txs: ", resp.txs.length);

        let wtResp: {[identifier: string]: WatchtowerClaimTxType<T>} = null;
        if(this.watchtower!=null) wtResp = await this.watchtower.syncToTipHash(resp.latestBlockHeader.hash, resp.computedHeaderMap);

        let swapsProcessed: number = 0;
        //TODO: Figure out some recovery here, since all relayers will be publishing blockheaders and claiming swaps
        try {
            let i = 0;
            const signatures = await this.chainData.chain.sendAndConfirm(
                this.chainData.signer, resp.txs, true, null, false,
                (txId: string, rawTx: string) => {
                    console.log("[Main]: Sending TX #"+i+", txHash: "+txId);
                    i++;
                    return Promise.resolve();
                }
            );

            if(wtResp!=null) swapsProcessed = await this.executeClaimTransactions(wtResp);

            //TODO: This is a relic from Solana-only implementation, sometimes things didn't quite work if we don't
            // wait for the finalization of the transaction (i.e. commitment = finalized)
            await new Promise(resolve => setTimeout(resolve, 5000));

            await this.trySweepForkData();
        } catch (e) {
            console.error("[Main]: syncToLatest(): Failed to sync to latest", e);
            console.log("[Main]: Trying to execute possible claim transactions anyway!");
            const latestKnownBlock = await this.chainData.btcRelay.retrieveLatestKnownBlockLog();
            swapsProcessed = await this.executeClaimTransactions(wtResp, latestKnownBlock.resultBitcoinHeader.getHeight());
        }

        return {
            blocks: nBlocks,
            txns: resp.txs.length,
            swapsClaimed: swapsProcessed
        }
    }

    /**
     * Initializes BTC relay with a block that already has 25 confirmations
     */
    async initializeBtcRelay(): Promise<void> {
        const tipHeight = (await this.bitcoinRpc.getTipHeight())-25;
        const lastDiffAdjustmentBlockHeight = tipHeight-(tipHeight%2016);

        const submitBlockHash = await this.bitcoinRpc.getBlockhash(tipHeight);
        const submitBlock = await this.bitcoinRpc.getBlockHeader(submitBlockHash);

        const lastDiffAdjBlockHash = await this.bitcoinRpc.getBlockhash(lastDiffAdjustmentBlockHeight);
        const lastDiffAdjBlock = await this.bitcoinRpc.getBlockHeader(lastDiffAdjBlockHash);

        const prevBlockTimestamps: number[] = [];
        let lastBlockHash = submitBlock.getPrevBlockhash();
        for(let i=0;i<10;i++) {
            const prevBlock = await this.bitcoinRpc.getBlockHeader(lastBlockHash);
            prevBlockTimestamps.push(prevBlock.getTimestamp());

            lastBlockHash = prevBlock.getPrevBlockhash();
        }

        const result = await this.chainData.btcRelay.saveInitialHeader(
            this.chainData.signer.getAddress(), submitBlock,
            lastDiffAdjBlock.getTimestamp(), prevBlockTimestamps.reverse()
        );

        const txIds = await this.chainData.chain.sendAndConfirm(
            this.chainData.signer, [result], true
        );

        console.log("[Main]: BTC relay initialized at: ", txIds);

        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    /**
     * Checks if BTC relay is initialized, initializes it when needed and returns the current tip state
     */
    async checkBtcRelayInitialized(): Promise<{ commitHash: string, blockhash: string, chainWork: Buffer, blockheight: number }> {
        let tipBlock = await this.chainData.btcRelay.getTipData();

        if(tipBlock==null) {
            await this.initializeBtcRelay();
            tipBlock = await this.chainData.btcRelay.getTipData();
        }

        return tipBlock;
    }

    /**
     * Subscribes to new bitcoin blocks through ZMQ
     */
    async subscribeToNewBlocks() {
        let syncing = false;
        let newBlock = false;

        let sync: () => void;
        sync = () => {
            if(syncing) {
                console.log("[Main]: Latching new block to true");
                newBlock = true;
                return;
            }
            console.log("[Main]: Syncing...");
            newBlock = false;
            syncing = true;
            this.syncToLatest().catch(e => {
                console.error(e);
            }).then(() => {
                syncing = false;
                if(newBlock) {
                    console.log("[Main]: New block latched to true, syncing again...");
                    sync();
                }
            });
        }

        console.log("[Main]: Listening to new blocks...");
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
                    console.log("[Main]: New blockhash: ", blockHash);
                    sync();
                } catch (e) {
                    console.error(e);
                    console.log("[Main]: Error occurred in new block listener or no new block in 15 minutes, resubscribing in 10 seconds");
                    sock.close();
                    sync();
                    await new Promise(resolve => setTimeout(resolve, 10*1000));
                    break;
                }
            }
        }
    }

    /**
     * Checks if IBD on the bitcoind has finished yet
     */
    async waitForBitcoinRpc() {
        console.log("[Main] Waiting for bitcoin RPC...");
        let rpcState: BtcSyncInfo = null;
        while(rpcState==null || rpcState.ibd) {
            rpcState = await this.bitcoinRpc.getSyncInfo().catch(e => {
                console.error(e);
                return null;
            });
            console.log("[Main] Bitcoin RPC state: ", rpcState==null ? "offline" : rpcState.ibd ? "IBD" : "ready");
            if(rpcState==null || rpcState.ibd) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] Bitcoin RPC ready, continue");
    }

    async executeClaimTransactions(txsMap: {[identifier: string]: WatchtowerClaimTxType<any>}, height?: number): Promise<number> {
        let count = 0;
        console.log("[Main]: Sending initial claim txns for "+Object.keys(txsMap).length+" swaps!");
        let promises: Promise<void>[] = [];
        for(let key in txsMap) {
            try {
                promises.push(txsMap[key].getTxs(height, height!=null).then(txs => {
                    console.log("[Main]: Sending initial claim txns, swap key: "+key+" num txs: "+(txs?.length ?? "NONE - not matured!"));
                    if(txs==null || txs.length===0) return;

                    return this.chainData.chain.sendAndConfirm(
                        this.chainData.signer, txs, true, null, false
                    )
                }).then(() => {
                    console.log("[Main]: Successfully claimed swap "+key);
                    count++;
                }).catch(e => {
                    console.error("[Main]: Error when claiming swap "+key, e);
                }));
            } catch (e) {
                console.error("[Main]: Error when claiming swap "+key, e);
            }
            if(promises.length>=MAX_BATCH_CLAIMS) {
                await Promise.all(promises);
                promises = [];
            }
        }

        await Promise.all(promises);

        return count;
    }

    async init() {
        await this.waitForBitcoinRpc();

        if(this.chainData.signer.init!=null) await this.chainData.signer.init();

        await this.storageManager.init();
        const data = await this.storageManager.loadData(NumberStorage);
        this.lastForkId = data[0]?.num;

        await this.chainData.swapContract.start();

        const tipBlock = await this.checkBtcRelayInitialized();
        console.log("[Main]: BTC relay tip commit hash: ", tipBlock.commitHash);
        console.log("[Main]: BTC relay tip block hash: ", tipBlock.blockhash);
        console.log("[Main]: BTC relay tip height: ", tipBlock.blockheight);

        if(this.watchtower!=null) await this.watchtower.init();
        if(this.hashlockWatchtower!=null) await this.hashlockWatchtower.init();
        if(this.watchtower!=null || this.hashlockWatchtower!=null) await this.chainData.chainEvents.init();
        if(this.hashlockWatchtower!=null) await this.hashlockWatchtower.subscribeToMessages();

        if(this.watchtower!=null) {
            const txsMap = await this.watchtower.initialSync();
            console.log("[Main]: Watchtower initialized! Returned claims: ", txsMap);
            await this.executeClaimTransactions(txsMap);
        }

        try {
            await this.syncToLatest();
            console.log("[Main]: Initial sync complete!");
        } catch (e) {
            console.error(e);
            console.log("[Main]: Initial sync failed! Continuing!");
        }

        this.subscribeToNewBlocks();
    }

}
