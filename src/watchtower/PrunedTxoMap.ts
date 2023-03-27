import BtcRPC from "../btc/BtcRPC";
import {createHash} from "crypto";
import * as fs from "fs/promises";
import {BitcoindHeader} from "../btcrelay/synchronizer/BtcRelaySynchronizer";

export type BitcoindVout = {
    value: number,
    n: number,
    scriptPubKey: {
        asm: string,
        hex: string,
        reqSigs: number,
        type: string,
        addresses: string[]
    }
};

export type BitcoindVin = {
    txid: string,
    vout: number,
    scriptSig: {
        asm: string,
        hex: string
    },
    sequence: number,
    txinwitness: string[]
};

export type BitcoindTransaction = {
    hex: string,
    txid: string,
    hash: string,
    size: number,
    vsize: number,
    weight: number,
    version: number,
    locktime: number,
    vin: BitcoindVin[],
    vout: BitcoindVout[],
    blockhash: string,
    confirmations: number,
    blocktime: number,
    time: number
};

type BitcoindBlock = {
    hash: string,
    confirmations: number,
    size: number,
    strippedsize: number,
    weight: number,
    height: number,
    version: number,
    versionHex: string,
    merkleroot: string,
    tx: BitcoindTransaction[],
    time: number,
    mediantime: number,
    nonce: number,
    bits: string,
    difficulty: number,
    nTx: number,
    previousblockhash: string,
    nextblockhash: string
}

const PRUNING_FACTOR = 30;

const map = new Map<string, {
    txId: string,
    vout: number,
    height: number
}>();
const blocksMap = new Map<number, {
    txoHashes: Buffer[],
    blockHash: string
}>();

const filename = "./storage/wt-height.txt";

class PrunedTxoMap {

    static tipHeight: number;

    static async init(btcRelayHeight: number): Promise<number> {

        //Load last synced blockheight
        try {
            const result = await fs.readFile(filename);
            const height = parseInt(result.toString());
            btcRelayHeight = height;
        } catch (e) {}

        PrunedTxoMap.tipHeight = btcRelayHeight;

        //Build up the index for the last synced blockheight
        for(let i=0;i<PRUNING_FACTOR;i++) {
            const blockHash = await new Promise<string>((resolve, reject) => {
                BtcRPC.getBlockHash(btcRelayHeight-i, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });

            const {block} = await PrunedTxoMap.addBlock(blockHash, null, true);
        }

        return PrunedTxoMap.tipHeight;

    }

    static async syncToTipHash(tipBlockHash: string, waitingForTxosMap?: Map<string, any>): Promise<Map<string, {
        txId: string,
        vout: number,
        height: number
    }>> {
        console.log("[PrunedTxoMap]: Syncing to tip hash: ", tipBlockHash);

        const blockHashes = [tipBlockHash];
        while(true) {
            const btcBlockHeader = await new Promise<BitcoindHeader>((resolve, reject) => {
                BtcRPC.getBlockHeader(blockHashes[blockHashes.length-1], true, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
            const previousHeight = btcBlockHeader.height-1;
            const previousHash = btcBlockHeader.previousblockhash;
            const data = blocksMap.get(previousHeight);

            //Correct block already in cache
            if(data!=null) {
                if(data.blockHash===previousHash) break;
            }

            //Will replace all the existing cache anyway
            const minBlockHeight = PrunedTxoMap.tipHeight-PRUNING_FACTOR;
            if(btcBlockHeader.height<minBlockHeight) {
                break;
            }

            blockHashes.push(btcBlockHeader.previousblockhash);
        }

        const totalFoundTxos = new Map<string, {
            txId: string,
            vout: number,
            height: number
        }>();

        console.log("[PrunedTxoMap]: Syncing through blockhashes: ", blockHashes);

        for(let i=blockHashes.length-1;i>=0;i--) {
            const {foundTxos} = await PrunedTxoMap.addBlock(blockHashes[i], waitingForTxosMap);
            foundTxos.forEach((value, key: string, map) => {
                totalFoundTxos.set(key, value);
            })
        }

        return totalFoundTxos;

    }

    static toTxoHash(value: number, outputScript: string): Buffer {
        const buff = Buffer.alloc((outputScript.length/2) + 8);
        buff.writeBigUInt64LE(BigInt(Math.round(value*100000000)));
        buff.write(outputScript, 8, "hex");
        return createHash("sha256").update(buff).digest();
    }

    static async addBlock(headerHash: string, waitingForTxosMap?: Map<string, any>, noSaveTipHeight?: boolean): Promise<{
        block: BitcoindBlock,
        foundTxos: Map<string, {
            txId: string,
            vout: number,
            height: number
        }>
    }> {

        const block = await new Promise<BitcoindBlock>((resolve, reject) => {
            BtcRPC.getBlock(headerHash, 2, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });

        console.log("[PrunedTxoMap]: Adding block  "+block.height+", hash: ", block.hash);
        if(!noSaveTipHeight) {
            PrunedTxoMap.tipHeight = block.height;
            await fs.writeFile(filename, PrunedTxoMap.tipHeight.toString());
        }

        const foundTxos = new Map<string, {
            txId: string,
            vout: number,
            height: number
        }>();

        const blockTxoHashes: Buffer[] = [];

        if(blocksMap.has(block.height)) {
            console.log("[PrunedTxoMap]: Fork block hash: ", block.hash);
            //Forked off
            for(let txoHash of blocksMap.get(block.height).txoHashes) {
                map.delete(txoHash.toString("hex"));
            }
        }

        for(let tx of block.tx) {
            for(let vout of tx.vout) {
                const txoHash = PrunedTxoMap.toTxoHash(vout.value, vout.scriptPubKey.hex);
                blockTxoHashes.push(txoHash);
                const txObj = {
                    txId: tx.txid,
                    vout: vout.n,
                    height: block.height
                };
                const txoHashHex = txoHash.toString("hex");
                map.set(txoHashHex, txObj);
                if(waitingForTxosMap!=null && waitingForTxosMap.has(txoHashHex)) {
                    foundTxos.set(txoHashHex, txObj);
                }
            }
        }

        blocksMap.set(block.height, {
            txoHashes: blockTxoHashes,
            blockHash: block.hash
        });

        //Pruned
        if(blocksMap.has(block.height-PRUNING_FACTOR)) {
            console.log("[PrunedTxoMap]: Pruning block height: ", block.height-PRUNING_FACTOR);
            //Forked off
            for(let txoHash of blocksMap.get(block.height-PRUNING_FACTOR).txoHashes) {
                map.delete(txoHash.toString("hex"));
            }
            blocksMap.delete(block.height-PRUNING_FACTOR);
        }

        return {
            block,
            foundTxos
        };

    }

    static getTxoObject(txoHash: string): {
        txId: string,
        vout: number,
        height: number
    } {
        return map.get(txoHash);
    }

}

export default PrunedTxoMap;