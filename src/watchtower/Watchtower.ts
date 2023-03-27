import PrunedTxoMap, {BitcoindTransaction} from "./PrunedTxoMap";
import * as fs from "fs/promises";
import SolEvents, {EventObject} from "../swaps/SolEvents";
import SwapProgram, {
    EscrowStateType,
    getEscrow,
    SwapEscrowState,
    SwapTxData,
    SwapUserVault, SwapVault, SwapVaultAuthority
} from "../swaps/program/SwapProgram";
import {SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction} from "@solana/web3.js";
import BtcRelay, {StoredHeader} from "../btcrelay/BtcRelay";
import BtcRPC from "../btc/BtcRPC";
import BTCMerkleTree from "../btcrelay/BTCMerkleTree";
import {BN} from "@project-serum/anchor";
import AnchorSigner from "../solana/AnchorSigner";
import BtcRelaySynchronizer, {BitcoindHeader} from "../btcrelay/synchronizer/BtcRelaySynchronizer";

const dirName = "./storage/swaps";

type SavedSwap = {
    txoHash: Buffer,
    hash: Buffer,
    confirmations: number,
};

class Watchtower {

    static hashMap: Map<string, SavedSwap> = new Map<string, SavedSwap>();
    static escrowMap: Map<string, SavedSwap> = new Map<string, SavedSwap>();

    static btcRelay: BtcRelay;
    static btcRelaySynchronizer: BtcRelaySynchronizer;

    static async load() {
        let files;
        try {
            files = await fs.readdir(dirName);
        } catch (e) {
            console.error(e);
        }

        if(files==null) return;

        for(let file of files) {
            const txoHashHex = file.split(".")[0];
            const result = await fs.readFile(dirName+"/"+file);
            const escrowData = JSON.parse(result.toString());

            escrowData.hash = Buffer.from(escrowData.hash, "hex");
            const txoHash = Buffer.from(txoHashHex, "hex");
            escrowData.txoHash = txoHash;

            Watchtower.escrowMap.set(txoHashHex, escrowData);
            Watchtower.hashMap.set(escrowData.hash.toString("hex"), escrowData);
        }
    }

    static async save(swap: SavedSwap) {
        try {
            await fs.mkdir(dirName)
        } catch (e) {}

        const cpy = {
            hash: swap.hash.toString("hex"),
            confirmations: swap.confirmations
        };

        Watchtower.escrowMap.set(swap.txoHash.toString("hex"), swap);
        Watchtower.hashMap.set(swap.hash.toString("hex"), swap);

        await fs.writeFile(dirName+"/"+swap.txoHash.toString("hex")+".json", JSON.stringify(cpy));
    }

    static async remove(txoHash: Buffer): Promise<boolean> {
        const retrieved = Watchtower.escrowMap.get(txoHash.toString("hex"));
        if(retrieved==null) return false;

        const txoHashHex = txoHash.toString("hex");
        try {
            await fs.rm(dirName+"/"+txoHashHex+".json");
        } catch (e) {
            console.error(e);
        }

        Watchtower.escrowMap.delete(txoHash.toString("hex"));
        Watchtower.hashMap.delete(retrieved.hash.toString("hex"));

        return true;
    }

    static async removeByHash(hash: Buffer): Promise<boolean> {
        const retrieved = Watchtower.hashMap.get(hash.toString("hex"));
        if(retrieved==null) return false;

        const txoHashHex = retrieved.txoHash.toString("hex");
        try {
            await fs.rm(dirName+"/"+txoHashHex+".json");
        } catch (e) {
            console.error(e);
        }

        Watchtower.escrowMap.delete(retrieved.txoHash.toString("hex"));
        Watchtower.hashMap.delete(hash.toString("hex"));

        return true;
    }

    static async createClaimTxs(txoHash: Buffer, swap: SavedSwap, txId: string, voutN: number, blockheight: number, escrowData?: EscrowStateType, computedCommitedHeaders?: {[height: number]: StoredHeader}): Promise<Transaction[] | null> {
        if(!escrowData) {
            escrowData = await getEscrow(swap.hash);
        }

        if(escrowData==null) return null;

        const tx = await new Promise<BitcoindTransaction>((resolve, reject) => {
            BtcRPC.getRawTransaction(txId, 1, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });

        //Re-check txoHash
        const vout = tx.vout[voutN];
        const computedTxoHash = PrunedTxoMap.toTxoHash(vout.value, vout.scriptPubKey.hex);

        if(!txoHash.equals(computedTxoHash)) throw new Error("TXO hash mismatch");

        if(tx.confirmations<escrowData.confirmations) throw new Error("Not enough confirmations yet");

        let storedHeader: StoredHeader;

        if(computedCommitedHeaders!=null) {
            storedHeader = computedCommitedHeaders[blockheight];
        }

        if(storedHeader==null) {
            storedHeader = await Watchtower.btcRelay.retrieveBlockLog(tx.blockhash, blockheight+swap.confirmations-1);
        }

        if(storedHeader==null) throw new Error("Cannot retrieve stored header");

        const merkleProof = await BTCMerkleTree.getTransactionMerkle(tx.txid, tx.blockhash);

        const rawTxBuffer: Buffer = Buffer.from(tx.hex, "hex");
        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(voutN).toArray("le", 4)),
            rawTxBuffer
        ]);

        const txDataKey = SwapTxData(merkleProof.reversedTxId, AnchorSigner.wallet.publicKey);

        const txs: Transaction[] = [];

        try {
            const fetchedDataAccount = await SwapProgram.account.data.fetch(txDataKey);
            console.log("[Solana.Claim] Will erase previous data account");
            const eraseTx = await SwapProgram.methods
                .closeData(merkleProof.reversedTxId)
                .accounts({
                    signer: AnchorSigner.wallet.publicKey,
                    data: txDataKey
                })
                .signers([AnchorSigner.signer])
                .transaction();
            txs.push(eraseTx);
        } catch (e) {}

        let pointer = 0;
        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 1000);

            const writeTx = await SwapProgram.methods
                .writeData(merkleProof.reversedTxId, writeData.length, writeData.slice(pointer, writeLen))
                .accounts({
                    signer: AnchorSigner.signer.publicKey,
                    data: txDataKey,
                    systemProgram: SystemProgram.programId
                })
                .signers([AnchorSigner.signer])
                .transaction();

            txs.push(writeTx);

            pointer += writeLen;
        }


        const verifyIx = await this.btcRelay.createVerifyIx(merkleProof.reversedTxId, escrowData.confirmations, merkleProof.pos, merkleProof.merkle, storedHeader);

        let claimIx;
        if(escrowData.payOut) {
            claimIx = await SwapProgram.methods
                .claimerClaimPayOutWithExtData(merkleProof.reversedTxId)
                .accounts({
                    signer: AnchorSigner.wallet.publicKey,
                    offerer: escrowData.offerer,
                    claimerReceiveTokenAccount: escrowData.claimerTokenAccount,
                    escrowState: SwapEscrowState(swap.hash),
                    vault: SwapVault(escrowData.mint),
                    data: txDataKey,
                    vaultAuthority: SwapVaultAuthority,
                    systemProgram: SystemProgram.programId,
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
                })
                .instruction();
        } else {
            claimIx = await SwapProgram.methods
                .claimerClaimWithExtData(merkleProof.reversedTxId)
                .accounts({
                    signer: AnchorSigner.wallet.publicKey,
                    claimer: escrowData.claimer,
                    offerer: escrowData.offerer,
                    initializer: escrowData.initializerKey,
                    data: txDataKey,
                    userData: SwapUserVault(escrowData.claimer, escrowData.mint),
                    escrowState: SwapEscrowState(swap.hash),
                    systemProgram: SystemProgram.programId,
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
                })
                .instruction();
        }

        const solanaTx = new Transaction();
        solanaTx.add(verifyIx);
        solanaTx.add(claimIx);

        txs.push(solanaTx);

        return txs;

    }

    static async claim(txoHash: Buffer, swap: SavedSwap, txId: string, vout: number, blockheight: number, escrowData?: EscrowStateType): Promise<boolean> {

        console.log("[Watchtower]: Claim swap: "+swap.hash.toString("hex")+" UTXO: ", txId+":"+vout+"@"+blockheight);

        try {
            const txs = await Watchtower.createClaimTxs(txoHash, swap, txId, vout, blockheight, escrowData);

            if(txs==null) {
                await Watchtower.remove(swap.txoHash);
                return false;
            }

            let signature;
            for(let tx of txs) {
                tx.feePayer = AnchorSigner.wallet.publicKey;
                tx.recentBlockhash = (await AnchorSigner.connection.getRecentBlockhash()).blockhash;
                signature = await AnchorSigner.sendAndConfirm(tx, [AnchorSigner.signer]);
            }

            console.log("[Watchtower]: Claim swap: "+swap.hash.toString("hex")+" success! Final signature: ", signature);

            await this.remove(txoHash);

            return true;
        } catch (e) {
            console.error(e);
            return false;
        }

    }

    static async init(tipBlockHash: string, btcRelaySynchronizer: BtcRelaySynchronizer) {

        Watchtower.btcRelay = btcRelaySynchronizer.btcRelay;
        Watchtower.btcRelaySynchronizer = btcRelaySynchronizer;

        await Watchtower.load();

        console.log("[Watchtower]: Loaded!");

        SolEvents.registerListener(async (obj: EventObject) => {
            for(let event of obj.events) {
                if(event.name==="InitializeEvent") {
                    const kind: number = event.data.kind;
                    const txoHash: Buffer = Buffer.from(event.data.txoHash);
                    const hash: Buffer = Buffer.from(event.data.hash);
                    if(kind!=1) continue; //Only process non-nonced chain request
                    if(txoHash.equals(Buffer.alloc(32, 0))) continue; //Opt-out flag

                    const txoHashHex = txoHash.toString("hex");

                    //Check with pruned tx map
                    const data = PrunedTxoMap.getTxoObject(txoHashHex);

                    const escrowState = await getEscrow(hash);
                    if(escrowState!=null) {
                        const savedSwap: SavedSwap = {
                            hash,
                            txoHash,
                            confirmations: escrowState.confirmations
                        };
                        console.log("[Watchtower]: Adding new swap to watchlist: ", savedSwap);
                        await this.save(savedSwap);
                        if(data!=null) {
                            const requiredBlockHeight = data.height+savedSwap.confirmations-1;
                            if(requiredBlockHeight<=PrunedTxoMap.tipHeight) {
                                //Claimable
                                await this.claim(txoHash, savedSwap, data.txId, data.vout, data.height);
                            }
                        }
                    }
                }
                if(event.name==="RefundEvent" || event.name==="ClaimEvent") {
                    const hash: Buffer = Buffer.from(event.data.hash);
                    const success = await Watchtower.removeByHash(hash);
                    if(success) {
                        console.log("[Watchtower]: Removed swap from watchlist: ", hash.toString("hex"));
                    }
                }
            }
            return true;
        });

        //Sync to latest on Solana
        await SolEvents.init();

        console.log("[Watchtower]: Synchronized sol events");

        const resp = await Watchtower.btcRelaySynchronizer.retrieveLatestKnownBlockLog();

        //Sync to previously processed block
        await PrunedTxoMap.init(resp.resultBitcoinHeader.height);

        for(let txoHash of this.escrowMap.keys()) {
            const data = PrunedTxoMap.getTxoObject(txoHash);
            console.log("[Watchtower] Check "+txoHash+":", data);
            if(data!=null) {
                const savedSwap = this.escrowMap.get(txoHash);
                const requiredBlockHeight = data.height+savedSwap.confirmations-1;
                if(requiredBlockHeight<=resp.resultBitcoinHeader.height) {
                    //Claimable
                    await this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
                }
            }
        }

        console.log("[Watchtower]: Synced to last processed block");

        //Sync to the btc relay height
        const includedTxoHashes = await PrunedTxoMap.syncToTipHash(resp.resultBitcoinHeader.hash, this.escrowMap);

        //Check if some of the txoHashes got confirmed
        for(let entry of includedTxoHashes.entries()) {
            const txoHash = entry[0];
            const data = entry[1];

            const savedSwap = this.escrowMap.get(txoHash);
            const requiredBlockHeight = data.height+savedSwap.confirmations-1;
            if(requiredBlockHeight<=resp.resultBitcoinHeader.height) {
                //Claimable
                await this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
            }
        }

        console.log("[Watchtower]: Synced to last btc relay block");
    }

    static async syncToTipHash(
        tipBlockHash: string,
        computedHeaderMap?: {[blockheight: number]: StoredHeader}
    ): Promise<{
        [txcHash: string]: {
            txs: Transaction[],
            txId: string,
            vout: number,
            maturedAt: number,
            hash: Buffer
        }
    }> {
        console.log("[Watchtower]: Syncing to tip hash: ", tipBlockHash);

        const txs: {
            [txcHash: string]: {
                txs: Transaction[],
                txId: string,
                vout: number,
                maturedAt: number,
                blockheight: number,
                hash: Buffer
            }
        } = {};

        //Check txoHashes that got required confirmations in these blocks,
        // but they might be already pruned if we only checked after
        const includedTxoHashes = await PrunedTxoMap.syncToTipHash(tipBlockHash, this.escrowMap);

        for(let entry of includedTxoHashes.entries()) {
            const txoHash = entry[0];
            const data = entry[1];

            const savedSwap = this.escrowMap.get(txoHash);
            const requiredBlockHeight = data.height+savedSwap.confirmations-1;
            if(requiredBlockHeight<=PrunedTxoMap.tipHeight) {
                //Claimable
                try {
                    const claimTxs = await this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, null, computedHeaderMap);
                    if(claimTxs==null)  {
                        await Watchtower.remove(savedSwap.txoHash);
                    } else {
                        txs[txoHash] = {
                            txs: claimTxs,
                            txId: data.txId,
                            vout: data.vout,
                            blockheight: data.height,
                            maturedAt: data.height+savedSwap.confirmations-1,
                            hash: savedSwap.hash
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        }

        //Check all the txs, if they are already confirmed in these blocks
        for(let txoHash of this.escrowMap.keys()) {
            const data = PrunedTxoMap.getTxoObject(txoHash);
            if(data!=null) {
                const savedSwap = this.escrowMap.get(txoHash);
                const requiredBlockHeight = data.height+savedSwap.confirmations-1;
                if(requiredBlockHeight<=PrunedTxoMap.tipHeight) {
                    //Claimable
                    try {
                        const claimTxs = await this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, null, computedHeaderMap);
                        if(claimTxs==null) {
                            await Watchtower.remove(savedSwap.txoHash);
                        } else {
                            txs[txoHash] = {
                                txs: claimTxs,
                                txId: data.txId,
                                vout: data.vout,
                                blockheight: data.height,
                                maturedAt: data.height+savedSwap.confirmations-1,
                                hash: savedSwap.hash
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
        }

        return txs;
    }

}

export default Watchtower;