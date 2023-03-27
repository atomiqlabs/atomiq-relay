import {AnchorProvider, BorshCoder, EventParser, Program} from "@project-serum/anchor";
import {programIdl} from "./program/programIdl";
import {PublicKey, TransactionInstruction} from "@solana/web3.js";

const LOG_FETCH_LIMIT = 500;

export type Header = {
    version: number,
    reversedPrevBlockhash: number[],
    merkleRoot: number[],
    timestamp: number,
    nbits: number,
    nonce: number
}

export type StoredHeader = {
    chainWork: number[],
    header: Header,
    lastDiffAdjustment: number,
    blockheight: number,
    prevBlockTimestamps: number[]
}

const HEADER_SEED = "header";
const FORK_SEED = "fork";
const BTC_RELAY_STATE_SEED = "state";

export default class BtcRelay {

    provider: AnchorProvider;
    programCoder: BorshCoder;
    program: Program;
    eventParser: EventParser;
    BtcRelayMainState: PublicKey;
    BtcRelayHeader: (hash: Buffer) => PublicKey;
    BtcRelayFork: (forkId: number, pubkey: PublicKey) => PublicKey;

    constructor(provider: AnchorProvider) {
        this.provider = provider;
        this.programCoder = new BorshCoder(programIdl as any);
        this.program = new Program(programIdl as any, programIdl.metadata.address, provider);
        this.eventParser = new EventParser(this.program.programId, this.programCoder);

        this.BtcRelayMainState = PublicKey.findProgramAddressSync(
            [Buffer.from(BTC_RELAY_STATE_SEED)],
            this.program.programId
        )[0];

        this.BtcRelayHeader = (hash: Buffer) => PublicKey.findProgramAddressSync(
            [Buffer.from(HEADER_SEED), hash],
            this.program.programId
        )[0];

        this.BtcRelayFork = (forkId: number, pubkey: PublicKey) => {
            const buff = Buffer.alloc(8);
            buff.writeBigUint64LE(BigInt(forkId));
            return PublicKey.findProgramAddressSync(
                [Buffer.from(FORK_SEED), buff, pubkey.toBuffer()],
                this.program.programId
            )[0];
        }
    }

    async retrieveBlockLogAndBlockheight(blockhash: string): Promise<{
        header: StoredHeader,
        height: number
    }> {
        let storedHeader: any = null;

        let lastSignature = null;

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        const blockHashBuffer = Buffer.from(blockhash, 'hex').reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    before: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(fetched.length===0) break;
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const logData: any = log.data;
                        if(blockHashBuffer.equals(Buffer.from(logData.blockHash))) {
                            const commitHash = Buffer.from(logData.commitHash).toString("hex");
                            if(storedCommitments.has(commitHash)) {
                                storedHeader = log.data.header;
                                break;
                            }
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return {
            header: storedHeader,
            height: mainState.blockHeight
        };
    }

    async retrieveBlockLog(blockhash: string, requiredBlockheight: number): Promise<StoredHeader> {
        //Retrieve the log
        let storedHeader: any = null;

        let lastSignature = null;

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

        if(mainState.blockHeight < requiredBlockheight) {
            //Btc relay not synchronized to required blockheight
            console.log("not synchronized to required blockheight");
            return null;
        }

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        const blockHashBuffer = Buffer.from(blockhash, 'hex').reverse();
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topicKey, {
                    before: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const logData: any = log.data;
                        if(blockHashBuffer.equals(Buffer.from(logData.blockHash))) {
                            const commitHash = Buffer.from(logData.commitHash).toString("hex");
                            if(storedCommitments.has(commitHash)) {
                                storedHeader = log.data.header;
                                break;
                            }
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return storedHeader;
    }

    createVerifyIx(reversedTxId: Buffer, confirmations: number, position: number, reversedMerkleProof: Buffer[], committedHeader: StoredHeader): Promise<TransactionInstruction> {
        return this.program.methods
            .verifyTransaction(
                reversedTxId,
                confirmations,
                position,
                reversedMerkleProof,
                committedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.BtcRelayMainState
            })
            .instruction();
    }

}