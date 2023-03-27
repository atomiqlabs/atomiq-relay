import {AnchorProvider, BN} from "@project-serum/anchor";
import BtcRelay, {Header, StoredHeader} from "../BtcRelay";
import {computeCommitedHeader, gtBuffer} from "./StatePredictor";
import {SystemProgram, Transaction} from "@solana/web3.js";
import BtcRPC from "../../btc/BtcRPC";

const MAX_HEADERS_PER_TX = 7;
const MAX_HEADERS_PER_TX_FORK = 6;

const limit = 500;

export type BitcoindHeader = {
    hash: string,
    confirmations: number,
    height: number,
    version: number,
    versionHex: string,
    merkleroot: string,
    time: number,
    mediantime: number,
    nonce: number,
    bits: string,
    difficulty: number,
    chainwork: string,
    nTx: number,
    previousblockhash: string,
    nextblockhash: string
}

class BtcRelaySynchronizer {

    provider: AnchorProvider;
    btcRelay: BtcRelay;

    constructor(provider: AnchorProvider, btcRelay: BtcRelay) {
        this.provider = provider;
        this.btcRelay = btcRelay;
    }

    async retrieveLog(spvCommitmentHash: Buffer, blockHash: Buffer): Promise<StoredHeader> {
        //Retrieve the log

        const topic = this.btcRelay.BtcRelayHeader(blockHash);

        let storedHeader = null;
        let lastSignature = null;
        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.btcRelay.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        if(Buffer.from(log.data.commitHash).equals(spvCommitmentHash)) {
                            storedHeader = log.data.header;
                            break;
                        }
                    }
                }

                if(storedHeader!=null) break;
            }

        }

        return storedHeader;
    }

    async retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: StoredHeader,
        resultBitcoinHeader: BitcoindHeader
    }> {
        //Retrieve the log
        let storedHeader = null;
        let bitcoinHeader = null;

        let lastSignature = null;

        const mainState: any = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(this.btcRelay.program.programId, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(this.btcRelay.program.programId, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.btcRelay.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const blockHash = Buffer.from(log.data.blockHash);
                        try {
                            const blockHashHex = blockHash.reverse().toString("hex");
                            const btcBlockHeader = await new Promise<BitcoindHeader>((resolve, reject) => {
                                BtcRPC.getBlockHeader(blockHashHex, true, (err, info) => {
                                    if(err) {
                                        reject(err);
                                        return;
                                    }
                                    resolve(info.result);
                                });
                            });
                            if(btcBlockHeader.confirmations>0) {
                                //Check if this fork is part of main chain
                                const commitHash = Buffer.from(log.data.commitHash).toString("hex");
                                if(storedCommitments.has(commitHash)) {
                                    bitcoinHeader = btcBlockHeader;
                                    storedHeader = log.data.header;
                                    break;
                                }
                            }
                        } catch (e) {
                            //Still in a fork
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return {
            resultStoredHeader: storedHeader,
            resultBitcoinHeader: bitcoinHeader
        };
    }

    static serializeBlockHeader(e: BitcoindHeader): Header & {hash: Buffer} {
        return {
            version: e.version,
            reversedPrevBlockhash: [...Buffer.from(e.previousblockhash, "hex").reverse()],
            merkleRoot: [...Buffer.from(e.merkleroot, "hex").reverse()],
            timestamp: e.time,
            nbits: Buffer.from(e.bits, "hex").readUint32BE(),
            nonce: e.nonce,
            hash: Buffer.from(e.hash, "hex").reverse()
        };
    }

    async saveMainHeaders(mainHeaders: BitcoindHeader[], storedHeader: StoredHeader) {
        const blockHeaderObj = mainHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        console.log("[BtcRelaySynchronizer]: Submitting headers: ", blockHeaderObj);

        const tx = await this.btcRelay.program.methods
            .submitBlockHeaders(
                blockHeaderObj,
                storedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        return {
            forkId: 0,
            lastStoredHeader: computedCommitedHeaders[computedCommitedHeaders.length-1],
            tx,
            computedCommitedHeaders
        }
    }

    async saveNewForkHeaders(forkHeaders: BitcoindHeader[], storedHeader: StoredHeader, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        const mainState: any = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        let forkId: BN = mainState.forkCounter;

        const tx = await this.btcRelay.program.methods
            .submitForkHeaders(
                blockHeaderObj,
                storedHeader,
                forkId,
                true
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
                forkState: this.btcRelay.BtcRelayFork(forkId.toNumber(), this.provider.publicKey),
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = new BN(0);
        }

        return {
            forkId: forkId.toNumber(),
            lastStoredHeader: changedCommitedHeader,
            tx,
            computedCommitedHeaders
        }
    }

    async saveForkHeaders(forkHeaders: BitcoindHeader[], storedHeader: StoredHeader, forkId: number, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        const tx = await this.btcRelay.program.methods
            .submitForkHeaders(
                blockHeaderObj,
                storedHeader,
                forkId,
                false
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
                forkState: this.btcRelay.BtcRelayFork(forkId, this.provider.publicKey),
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = 0;
        }

        return {
            forkId: forkId,
            lastStoredHeader: changedCommitedHeader,
            tx,
            computedCommitedHeaders
        }
    }

    async getBtcRelayTipBlock(): Promise<BitcoindHeader> {
        const acc = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        let spvTipBlockHeader: BitcoindHeader;
        try {
            const blockHashHex = Buffer.from(acc.tipBlockHash).reverse().toString("hex");
            console.log("[BtcRelaySynchronizer]: Stored tip hash: ", blockHashHex);
            const btcBlockHeader = await new Promise<BitcoindHeader>((resolve, reject) => {
                BtcRPC.getBlockHeader(blockHashHex, true, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
            if(btcBlockHeader.confirmations<=0) throw new Error("Block not in main chain");
            spvTipBlockHeader = btcBlockHeader;
        } catch (e) {
            console.error(e);
            //Block not found, therefore relay tip is probably in a fork
            const {resultStoredHeader, resultBitcoinHeader} = await this.retrieveLatestKnownBlockLog();
            spvTipBlockHeader = resultBitcoinHeader;
        }

        return spvTipBlockHeader;
    }

    async syncToLatestTxs(): Promise<{
        txs: Transaction[]
        targetCommitedHeader: StoredHeader,
        computedHeaderMap: {[blockheight: number]: StoredHeader},
        blockHeaderMap: {[blockheight: number]: BitcoindHeader},
        btcRelayTipBlockHash: string,
        latestBlockHeader: BitcoindHeader
    }> {

        const acc = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        const spvTipCommitment = Buffer.from(acc.tipCommitHash);
        const blockHashTip = Buffer.from(acc.tipBlockHash);

        let mainChainWork = Buffer.from(acc.chainWork);
        let cacheData: {
            forkId: number,
            lastStoredHeader: StoredHeader,
            tx: Transaction,
            computedCommitedHeaders: StoredHeader[]
        } = {
            forkId: 0,
            lastStoredHeader: null,
            tx: null,
            computedCommitedHeaders: null
        };

        let btcRelayTipBlockHash: string;

        let spvTipBlockHeader: BitcoindHeader;
        try {
            const blockHashHex = Buffer.from(acc.tipBlockHash).reverse().toString("hex");
            console.log("[BtcRelaySynchronizer]: Stored tip hash: ", blockHashHex);
            const btcBlockHeader = await new Promise<BitcoindHeader>((resolve, reject) => {
                BtcRPC.getBlockHeader(blockHashHex, true, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
            if(btcBlockHeader.confirmations<=0) throw new Error("Block not in main chain");
            cacheData.lastStoredHeader = await this.retrieveLog(spvTipCommitment, blockHashTip);
            spvTipBlockHeader = btcBlockHeader;
            btcRelayTipBlockHash = btcBlockHeader.hash;
        } catch (e) {
            console.error(e);
            //Block not found, therefore relay tip is probably in a fork
            const {resultStoredHeader, resultBitcoinHeader} = await this.retrieveLatestKnownBlockLog();
            cacheData.lastStoredHeader = resultStoredHeader;
            cacheData.forkId = -1; //Indicate that we will be submitting blocks to fork
            spvTipBlockHeader = resultBitcoinHeader;
            btcRelayTipBlockHash = resultBitcoinHeader.hash;
        }

        console.log("[BtcRelaySynchronizer]: Retrieved stored header with commitment: ", cacheData.lastStoredHeader);

        console.log("[BtcRelaySynchronizer]: SPV tip hash: ", blockHashTip.toString("hex"));

        console.log("[BtcRelaySynchronizer]: SPV tip header: ", spvTipBlockHeader);

        const txsList: Transaction[] = [];
        const blockHeaderMap: {[blockheight: number]: BitcoindHeader} = {
            [spvTipBlockHeader.height]: spvTipBlockHeader
        };
        const computedHeaderMap: {[blockheight: number]: StoredHeader} = {};

        const saveHeaders = async (headerCache: BitcoindHeader[]) => {
            console.log("[BtcRelaySynchronizer]: Header cache: ", headerCache);
            if(cacheData.forkId===-1) {
                cacheData = await this.saveNewForkHeaders(headerCache, cacheData.lastStoredHeader, mainChainWork)
            } else if(cacheData.forkId===0) {
                cacheData = await this.saveMainHeaders(headerCache, cacheData.lastStoredHeader);
            } else {
                cacheData = await this.saveForkHeaders(headerCache, cacheData.lastStoredHeader, cacheData.forkId, mainChainWork)
            }
            txsList.push(cacheData.tx);
            for(let storedHeader of cacheData.computedCommitedHeaders) {
                computedHeaderMap[storedHeader.blockheight] = storedHeader;
            }
        };

        let headerCache: BitcoindHeader[] = [];
        while(spvTipBlockHeader.nextblockhash!=null) {

            const retrievedHeader = await new Promise<BitcoindHeader>((resolve, reject) => {
                BtcRPC.getBlockHeader(spvTipBlockHeader.nextblockhash, true, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });

            blockHeaderMap[retrievedHeader.height] = retrievedHeader;
            headerCache.push(retrievedHeader);

            if(cacheData.forkId===0 ?
                headerCache.length>=MAX_HEADERS_PER_TX :
                headerCache.length>=MAX_HEADERS_PER_TX_FORK) {

                await saveHeaders(headerCache);

                headerCache = [];
            }

            spvTipBlockHeader = retrievedHeader;

            if(retrievedHeader.nextblockhash!=null) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        if(headerCache.length>0) {
            await saveHeaders(headerCache);
        }

        return {
            txs: txsList,
            targetCommitedHeader: cacheData.lastStoredHeader,
            blockHeaderMap,
            computedHeaderMap,
            btcRelayTipBlockHash,

            latestBlockHeader: spvTipBlockHeader
        };

    }

}

export default BtcRelaySynchronizer;