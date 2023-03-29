import * as dotenv from "dotenv";
dotenv.config();

import BtcRelay from "./btcrelay/BtcRelay";
import AnchorSigner from "./solana/AnchorSigner";
import BtcRelaySynchronizer from "./btcrelay/synchronizer/BtcRelaySynchronizer";
import Watchtower from "./watchtower/Watchtower";
import * as fs from "fs/promises";
import {Subscriber} from "zeromq";
import PrunedTxoMap from "./watchtower/PrunedTxoMap";

async function syncToLatest(synchronizer: BtcRelaySynchronizer) {

    console.log("[Main]: Syncing to latest...");

    const resp = await synchronizer.syncToLatestTxs();

    const nBlocks = Object.keys(resp.blockHeaderMap).length-1;
    console.log("[Main]: Synchronizing blocks: ", nBlocks);
    console.log("[Main]: Synchronizing blocks in # txs: ", resp.txs.length);

    const wtResp = await Watchtower.syncToTipHash(resp.latestBlockHeader.hash, resp.computedHeaderMap);
    const nProcessed = Object.keys(wtResp).length;
    console.log("[Main]: Claiming # ptlcs: ", nProcessed);

    const totalTxs = resp.txs;
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
        const signature = await AnchorSigner.sendAndConfirm(tx, [AnchorSigner.signer]);
        console.log("[Main]: TX sent: ", signature);
    }

}

async function main() {

    try {
        await fs.mkdir("storage")
    } catch (e) {}

    const btcRelay = new BtcRelay(AnchorSigner);
    const synchronizer = new BtcRelaySynchronizer(AnchorSigner, btcRelay);

    const tipBlock = await synchronizer.getBtcRelayTipBlock();

    console.log("[Main]: BTC relay tip block: ", tipBlock);

    await Watchtower.init(tipBlock.hash, synchronizer);

    console.log("[Main]: Watchtower initialized!");

    await syncToLatest(synchronizer);

    console.log("[Main]: Initial sync complete!");

    const sock = new Subscriber();
    sock.connect("tcp://"+process.env.BTC_HOST+":"+process.env.ZMQ_PORT);
    sock.subscribe("hashblock");

    console.log("[Main]: Listening to new blocks...");
    while(true) {
        for await (const [topic, msg] of sock) {
            const blockHash = msg.toString("hex");
            console.log("[Main]: New blockhash: ", blockHash);
            await syncToLatest(synchronizer);
        }
        console.log("[Main]: ZMQ disconnected...");
    }

}

main().catch(e => {
    console.error(e);
});