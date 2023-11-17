import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "./solana/AnchorSigner";
import * as fs from "fs/promises";
import {Subscriber} from "zeromq";
import {Signer, Transaction} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaBtcStoredHeader, SolanaSwapData, SolanaSwapProgram} from "crosslightning-solana";
import {BtcRPCConfig} from "./btc/BtcRPC";
import {StorageManager} from "./storagemanager/StorageManager";
import {BitcoindBlock, BitcoindRpc, BtcRelaySynchronizer} from "btcrelay-bitcoind";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {Watchtower} from "btcrelay-watchtower";

type SolTx = {
    tx: Transaction,
    signers: Signer[]
};

async function syncToLatest(
    synchronizer: BtcRelaySynchronizer<SolanaBtcStoredHeader, SolTx>,
    watchtower: Watchtower<SolanaSwapData,SolanaBtcStoredHeader,SolTx>
) {

    console.log("[Main]: Syncing to latest...");

    const resp = await synchronizer.syncToLatestTxs();

    const nBlocks = Object.keys(resp.blockHeaderMap).length-1;
    console.log("[Main]: Synchronizing blocks: ", nBlocks);
    console.log("[Main]: Synchronizing blocks in # txs: ", resp.txs.length);

    const wtResp = await watchtower.syncToTipHash(resp.latestBlockHeader.hash, resp.computedHeaderMap);
    const nProcessed = Object.keys(wtResp).length;
    console.log("[Main]: Claiming # ptlcs: ", nProcessed);

    const totalTxs: {
        tx: Transaction,
        signers: Signer[]
    }[] = [];
    resp.txs.forEach(tx => {
        totalTxs.push(tx);
    });

    for(let key in wtResp) {
        wtResp[key].txs.forEach(e => {
            totalTxs.push(e);
        });
    }

    console.log("[Main]: Sending total # txs: ", totalTxs.length);

    //TODO: Figure out some recovery here, since all relayers will be publishing blookheaders and claiming swaps
    for(let i=0;i<totalTxs.length;i++) {
        const tx = totalTxs[i];
        console.log("[Main]: Sending tx: ", i);
        let signature: string;
        if(i===totalTxs.length-1) {
            signature = await AnchorSigner.sendAndConfirm(tx.tx, tx.signers.concat([AnchorSigner.signer]), {
                commitment: "finalized"
            });
        } else {
            signature = await AnchorSigner.sendAndConfirm(tx.tx, tx.signers.concat([AnchorSigner.signer]));
        }
        console.log("[Main]: TX sent: ", signature);
    }

}

async function main() {

    try {
        await fs.mkdir("storage")
    } catch (e) {}

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay<BitcoindBlock>(AnchorSigner, bitcoinRpc, process.env.BTC_RELAY_CONTRACT_ADDRESS);
    const synchronizer = new BtcRelaySynchronizer(btcRelay, bitcoinRpc);

    const swapProgram = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager("./storage/solaccounts"), process.env.SWAP_CONTRACT_ADDRESS);

    await swapProgram.start();

    const chainEvents = new SolanaChainEvents("./storage/events", AnchorSigner, swapProgram);

    const watchtower = new Watchtower<SolanaSwapData,SolanaBtcStoredHeader,SolTx>("./storage/wt", btcRelay, synchronizer, chainEvents, swapProgram, bitcoinRpc, 30);

    let tipBlock = await btcRelay.getTipData();

    if(tipBlock==null) {
        const tipHeight = (await bitcoinRpc.getTipHeight())-25;
        const lastDiffAdjustmentBlockHeight = tipHeight-(tipHeight%2016);

        const submitBlockHash = await bitcoinRpc.getBlockhash(tipHeight);
        const submitBlock = await bitcoinRpc.getBlockHeader(submitBlockHash);

        const lastDiffAdjBlockHash = await bitcoinRpc.getBlockhash(lastDiffAdjustmentBlockHeight);
        const lastDiffAdjBlock = await bitcoinRpc.getBlockHeader(lastDiffAdjBlockHash);

        const prevBlockTimestamps: number[] = [];
        let lastBlockHash = submitBlock.getPrevBlockhash();
        for(let i=0;i<10;i++) {
            const prevBlock = await bitcoinRpc.getBlockHeader(lastBlockHash);
            prevBlockTimestamps.push(prevBlock.getTimestamp());

            lastBlockHash = prevBlock.getPrevBlockhash();
        }

        const tx = await btcRelay.saveInitialHeader(submitBlock, lastDiffAdjBlock.getTimestamp(), prevBlockTimestamps.reverse());

        const signature = await AnchorSigner.sendAndConfirm(tx.tx, tx.signers.concat([AnchorSigner.signer]));

        console.log("[Main]: BTC relay initialized at: ", signature);

        await new Promise(resolve => setTimeout(resolve, 5000));

        tipBlock = await btcRelay.getTipData();
    }

    console.log("[Main]: BTC relay tip blockhash: ", tipBlock.blockhash);

    await watchtower.init();

    console.log("[Main]: Watchtower initialized!");

    await syncToLatest(synchronizer, watchtower);

    console.log("[Main]: Initial sync complete!");

    const sock = new Subscriber();
    sock.connect("tcp://"+process.env.BTC_HOST+":"+process.env.ZMQ_PORT);
    sock.subscribe("hashblock");

    console.log("[Main]: Listening to new blocks...");
    while(true) {
        try {
            for await (const [topic, msg] of sock) {
                const blockHash = msg.toString("hex");
                console.log("[Main]: New blockhash: ", blockHash);
                await syncToLatest(synchronizer, watchtower);
            }
        } catch (e) {
            console.error(e);
            console.log("[Main]: Error occurred in main...");
        }
    }

}

main().catch(e => {
    console.error(e);
});
