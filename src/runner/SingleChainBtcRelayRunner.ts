import {StorageManager} from "../storagemanager/StorageManager";

import {BitcoindRpc, BtcRelaySynchronizer} from "@atomiqlabs/btc-bitcoind";
import {BtcRelayWatchtower, HashlockSavedWatchtower, WatchtowerClaimTxType} from "@atomiqlabs/watchtower-lib";
import {
    BtcSyncInfo,
    ChainType,
    Messenger,
    StorageObject,
} from "@atomiqlabs/base";
import {ChainData} from "../chains/ChainInitializer";
import {getLogger, LoggerType} from "../Utils";
import fs from "fs/promises";

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

export type ChainBtcRelayStatus = "offline" | "awaiting_funds" | "signer_init" | "relay_check" | "watchtowers_init" | "events_sync" | "initial_sync" | "active";

const KEY: string = "FORK";
const MAX_BATCH_CLAIMS: number = 15;

export class SingleChainBtcRelayRunner<T extends ChainType> {

    readonly storageManager: StorageManager<NumberStorage>;
    readonly bitcoinRpc: BitcoindRpc;
    readonly synchronizer: BtcRelaySynchronizer<any, T["TX"]>;
    readonly watchtower: BtcRelayWatchtower<T, any>;
    readonly hashlockWatchtower: HashlockSavedWatchtower<T>;
    readonly chainData: ChainData<T>;

    readonly directory: string;

    lastForkId: number;
    status: ChainBtcRelayStatus = "offline";

    readonly logger: LoggerType;

    constructor(
        directory: string,
        chainData: ChainData<T>,
        bitcoinRpc: BitcoindRpc,
        messenger: Messenger,
        enabledWatchtowers?: {
            LEGACY_SWAPS?: boolean,
            SPV_SWAPS?: boolean,
            HTLC_SWAPS?: boolean
        }
    ) {
        this.logger = getLogger(`${chainData.chainId}: `);
        this.directory = directory;
        this.chainData = chainData;
        this.bitcoinRpc = bitcoinRpc;

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
                this.logger.debug("trySweepForkData(): Run sweep fork accounts, last swept: ", this.lastForkId);
                const newForkId = await this.chainData.btcRelay.sweepForkData(this.chainData.signer, this.lastForkId);
                if(newForkId!=null && newForkId!==this.lastForkId) {
                    await this.storageManager.saveData(KEY, new NumberStorage(newForkId));
                    this.lastForkId = newForkId;
                }
                this.logger.debug("trySweepForkData(): Run sweep fork success, new last swept: ", newForkId);
            } catch (e) {
                this.logger.error(e);
            }
        }
    }

    /**
     * Syncs the BTC relay to the latest tip block, claiming PrTLCs along the way
     */
    private async _syncToLatest() {
        this.logger.info("_syncToLatest(): Syncing to latest...");
        const resp = await this.synchronizer.syncToLatestTxs(this.chainData.signer.getAddress());

        const nBlocks = Object.keys(resp.blockHeaderMap).length-1;
        this.logger.debug("_syncToLatest(): Synchronizing blocks: ", nBlocks);
        this.logger.debug("_syncToLatest(): Synchronizing blocks in # txs: ", resp.txs.length);

        let wtResp: {[identifier: string]: WatchtowerClaimTxType<T>} = null;
        if(this.watchtower!=null) wtResp = await this.watchtower.syncToTipHash(resp.latestBlockHeader.hash, resp.computedHeaderMap);

        let swapsProcessed: number = 0;
        //TODO: Figure out some recovery here, since all relayers will be publishing blockheaders and claiming swaps
        try {
            let i = 0;
            const signatures = await this.chainData.chain.sendAndConfirm(
                this.chainData.signer, resp.txs, true, null, false,
                (txId: string, rawTx: string) => {
                    this.logger.debug("_syncToLatest(): Sending TX #"+i+", txHash: "+txId);
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
            this.logger.error("_syncToLatest(): syncToLatest(): Failed to sync to latest", e);
            this.logger.info("_syncToLatest(): Trying to execute possible claim transactions anyway!");
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

        this.logger.info("initializeBtcRelay(): BTC relay initialized at: ", txIds);

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

    syncing: boolean = false;
    newBlock: boolean = false;

    syncToLatest() {
        if(this.status!=="active") return;

        if(this.syncing) {
            this.logger.info("syncToLatest(): Latching new block to true");
            this.newBlock = true;
            return;
        }
        this.logger.info("syncToLatest(): Syncing...");
        this.newBlock = false;
        this.syncing = true;
        this._syncToLatest().catch(e => {
            this.logger.error(e);
        }).then(() => {
            this.syncing = false;
            if(this.newBlock) {
                this.logger.info("syncToLatest(): New block latched to true, syncing again...");
                this.syncToLatest();
            }
        });
    }

    async executeClaimTransactions(txsMap: {[identifier: string]: WatchtowerClaimTxType<any>}, height?: number): Promise<number> {
        let count = 0;
        this.logger.info("executeClaimTransactions(): Sending initial claim txns for "+Object.keys(txsMap).length+" swaps!");
        let promises: Promise<void>[] = [];
        for(let key in txsMap) {
            try {
                promises.push(txsMap[key].getTxs(height, height!=null).then(txs => {
                    this.logger.debug("executeClaimTransactions(): Sending initial claim txns, swap key: "+key+" num txs: "+(txs?.length ?? "NONE - not matured!"));
                    if(txs==null || txs.length===0) return;

                    return this.chainData.chain.sendAndConfirm(
                        this.chainData.signer, txs, true, null, false
                    )
                }).then(() => {
                    this.logger.info("executeClaimTransactions(): Successfully claimed swap "+key);
                    count++;
                }).catch(e => {
                    this.logger.error(`executeClaimTransactions(): Error when claiming swap ${key}, marking it as reverted & not re-attempting!`, e);
                    if(this.watchtower!=null) this.watchtower.markClaimReverted(key);
                }));
            } catch (e) {
                this.logger.error("executeClaimTransactions(): Error when claiming swap "+key, e);
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
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        const {signer, chain, swapContract, chainEvents} = this.chainData;

        this.status = "awaiting_funds";

        let onchainBalance: bigint;
        do {
            onchainBalance = await chain.getBalance(signer.getAddress(), chain.getNativeCurrencyAddress());
            if(onchainBalance<=0n) {
                await new Promise(resolve => setTimeout(resolve, 5*60*1000));
                this.logger.warn(`======`);
                this.logger.warn(`init(): Balance is zero for ${chain.chainId} relayer & watchtower disabled, re-checking in 5 minutes!`);
                this.logger.warn(`======`);
            }
        } while(onchainBalance<=0n);

        this.status = "signer_init";

        if(signer.init!=null) await signer.init();

        await this.storageManager.init();
        const data = await this.storageManager.loadData(NumberStorage);
        this.lastForkId = data[0]?.num;

        await swapContract.start();

        this.status = "relay_check";

        const tipBlock = await this.checkBtcRelayInitialized();
        this.logger.info("init(): BTC relay tip commit hash: ", tipBlock.commitHash);
        this.logger.info("init(): BTC relay tip block hash: ", tipBlock.blockhash);
        this.logger.info("init(): BTC relay tip height: ", tipBlock.blockheight);

        this.status = "watchtowers_init";

        if(this.watchtower!=null) await this.watchtower.init();
        if(this.hashlockWatchtower!=null) await this.hashlockWatchtower.init();

        this.status = "events_sync";

        if(this.watchtower!=null || this.hashlockWatchtower!=null) await chainEvents.init();
        if(this.hashlockWatchtower!=null) await this.hashlockWatchtower.subscribeToMessages();

        this.status = "initial_sync";

        if(this.watchtower!=null) {
            const txsMap = await this.watchtower.initialSync();
            this.logger.info("init(): Watchtower initialized! Returned claims: ", txsMap);
            await this.executeClaimTransactions(txsMap);
        }

        try {
            await this._syncToLatest();
            this.logger.info("init(): Initial sync complete!");
        } catch (e) {
            this.logger.error(e);
            this.logger.info("init(): Initial sync failed! Continuing!");
        }

        this.status = "active";
    }

}
