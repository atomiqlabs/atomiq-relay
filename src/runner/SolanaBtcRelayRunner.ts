import {StorageManager} from "../storagemanager/StorageManager";
import AnchorSigner from "../solana/AnchorSigner";

import {Subscriber} from "zeromq";
import {ComputeBudgetProgram, Signer, Transaction, Keypair} from "@solana/web3.js";
import {AnchorProvider} from "@coral-xyz/anchor";
import {SolanaBtcRelay, SolanaBtcStoredHeader, SolanaFeeEstimator, SolanaSwapData, SolanaSwapProgram} from "crosslightning-solana";
import {BitcoindBlock, BitcoindRpc, BtcRelaySynchronizer} from "btcrelay-bitcoind";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {Watchtower} from "btcrelay-watchtower";
import {BtcRelay, BtcSyncInfo, StorageObject, SwapContract} from "crosslightning-base";
import * as BN from "bn.js";

type SolTx = {
    tx: Transaction,
    signers: Signer[]
};

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

export class SolanaBtcRelayRunner {

    readonly storageManager: StorageManager<NumberStorage>;
    readonly signer: (AnchorProvider & {signer: Keypair});
    readonly bitcoinRpc: BitcoindRpc;
    readonly btcRelay: SolanaBtcRelay<BitcoindBlock>;
    readonly synchronizer: BtcRelaySynchronizer<any, any>;
    readonly swapProgram: SolanaSwapProgram;
    readonly chainEvents: SolanaChainEvents;
    readonly watchtower: Watchtower<SolanaSwapData, SolanaBtcStoredHeader, SolTx>;

    readonly zmqHost: string;
    readonly zmqPort: number;

    lastForkId: number;

    constructor(
        signer: (AnchorProvider & {signer: Keypair}),
        bitcoinRpc: BitcoindRpc,
        btcRelay: SolanaBtcRelay<BitcoindBlock>,
        zmqHost: string,
        zmqPort: number
    ) {
        this.signer = signer;
        this.bitcoinRpc = bitcoinRpc;
        this.btcRelay = btcRelay;
        this.zmqHost = zmqHost;
        this.zmqPort = zmqPort;

        this.storageManager = new StorageManager<NumberStorage>(process.env.STORAGE_DIR+"/forkData");

        this.synchronizer = new BtcRelaySynchronizer(btcRelay, bitcoinRpc);

        this.swapProgram = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager(process.env.STORAGE_DIR+"/solaccounts"), process.env.SWAP_CONTRACT_ADDRESS);

        this.chainEvents = new SolanaChainEvents(process.env.STORAGE_DIR+"/events", AnchorSigner, this.swapProgram, 30*1000);
        this.watchtower = new Watchtower<SolanaSwapData,SolanaBtcStoredHeader,SolTx>(process.env.STORAGE_DIR+"/wt", btcRelay, this.synchronizer, this.chainEvents, this.swapProgram, bitcoinRpc, 30);
    }

    /**
     * Tries to sweep/delete existing fork data accounts
     */
    async trySweepForkData() {
        if(this.btcRelay.sweepForkData!=null) {
            try {
                console.log("[Main]: Run sweep fork accounts, last swept: ", this.lastForkId);
                const newForkId = await this.btcRelay.sweepForkData(this.lastForkId);
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
        const resp = await this.synchronizer.syncToLatestTxs();

        const nBlocks = Object.keys(resp.blockHeaderMap).length-1;
        console.log("[Main]: Synchronizing blocks: ", nBlocks);
        console.log("[Main]: Synchronizing blocks in # txs: ", resp.txs.length);

        const wtResp = await this.watchtower.syncToTipHash(resp.latestBlockHeader.hash, resp.computedHeaderMap);
        const nProcessed = Object.keys(wtResp).length;
        console.log("[Main]: Claiming # ptlcs: ", nProcessed);

        const totalTxs: {
            tx: Transaction,
            signers: Signer[]
        }[] = [];
        //Sync txns
        resp.txs.forEach(tx => {
            totalTxs.push(tx);
        });
        //Watchtower txns
        for(let key in wtResp) {
            wtResp[key].txs.forEach(e => {
                totalTxs.push(e);
            });
        }

        console.log("[Main]: Sending total # txs: ", totalTxs.length);

        //TODO: Figure out some recovery here, since all relayers will be publishing blockheaders and claiming swaps
        for(let i=0;i<totalTxs.length;i++) {
            const tx = totalTxs[i];
            console.log("[Main]: Sending tx: ", i);
            let signature: string;
            if(i===totalTxs.length-1) {
                const [_signature] = await this.swapProgram.sendAndConfirm([tx], true);
                signature = _signature;
                await AnchorSigner.connection.confirmTransaction(signature, "finalized");
            } else {
                const [_signature] = await this.swapProgram.sendAndConfirm([tx], true);
                signature = _signature;
            }
            console.log("[Main]: TX sent: ", signature);
        }

        await this.trySweepForkData();

        return {
            blocks: nBlocks,
            txns: totalTxs.length,
            ptlcsClaimed: nProcessed
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

        const tx = await this.btcRelay.saveInitialHeader(submitBlock, lastDiffAdjBlock.getTimestamp(), prevBlockTimestamps.reverse());

        const signature = await AnchorSigner.sendAndConfirm(tx.tx, tx.signers.concat([AnchorSigner.signer]));

        console.log("[Main]: BTC relay initialized at: ", signature);

        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    /**
     * Checks if BTC relay is initialized, initializes it when needed and returns the current tip state
     */
    async checkBtcRelayInitialized(): Promise<{ commitHash: string; blockhash: string, chainWork: Buffer, blockheight: number }> {
        let tipBlock = await this.btcRelay.getTipData();

        if(tipBlock==null) {
            await this.initializeBtcRelay();
            tipBlock = await this.btcRelay.getTipData();
        }

        return tipBlock;
    }

    /**
     * Subscribes to new bitcoin blocks through ZMQ
     */
    async subscribeToNewBlocks() {
        const sock = new Subscriber();
        sock.connect("tcp://"+this.zmqHost+":"+this.zmqPort);
        sock.subscribe("hashblock");

        console.log("[Main]: Listening to new blocks...");
        while(true) {
            try {
                for await (const [topic, msg] of sock) {
                    const blockHash = msg.toString("hex");
                    console.log("[Main]: New blockhash: ", blockHash);
                    this.syncToLatest().catch(e => {
                        console.error(e);
                    });
                }
            } catch (e) {
                console.error(e);
                console.log("[Main]: Error occurred in main (bitcoind crashed???)...");
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

    async init() {
        await this.waitForBitcoinRpc();

        await this.storageManager.init();
        const data = await this.storageManager.loadData(NumberStorage);
        this.lastForkId = data[0]?.num;

        await this.swapProgram.start();

        const tipBlock = await this.checkBtcRelayInitialized();
        console.log("[Main]: BTC relay tip blockhash: ", tipBlock.blockhash);
        console.log("[Main]: BTC relay tip height: ", tipBlock.blockheight);

        await this.watchtower.init();
        console.log("[Main]: Watchtower initialized!");

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
