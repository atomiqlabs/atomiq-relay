import {programIdl} from "./programIdl";
import {BN, BorshCoder, EventParser, Program} from "@project-serum/anchor";
import {PublicKey} from "@solana/web3.js";
import AnchorSigner from "../../solana/AnchorSigner";


const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const TX_DATA_SEED = "data";

export const swapProgramCoder = new BorshCoder(programIdl as any);
const SwapProgram = new Program(programIdl as any, programIdl.metadata.address, AnchorSigner);
export const swapProgramEvetnParser = new EventParser(SwapProgram.programId, swapProgramCoder);

export default SwapProgram;

export const SwapVaultAuthority: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(AUTHORITY_SEED)],
    SwapProgram.programId
)[0];

export const SwapVault: (token: PublicKey) => PublicKey = (token: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), token.toBuffer()],
    SwapProgram.programId
)[0];

export const SwapUserVault: (publicKey: PublicKey, token: PublicKey) => PublicKey = (publicKey: PublicKey, token: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), publicKey.toBuffer(), token.toBuffer()],
    SwapProgram.programId
)[0];

export const SwapEscrowState: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
    [Buffer.from(STATE_SEED), hash],
    SwapProgram.programId
)[0];

export const SwapTxData: (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey = (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(TX_DATA_SEED), reversedTxId, pubkey.toBuffer()],
    SwapProgram.programId
)[0];

export type EscrowStateType = {
    kind: number,
    confirmations: number,
    nonce: BN,
    hash: number[],
    initializerKey: PublicKey,
    payIn: boolean,
    payOut: boolean,
    offerer: PublicKey,
    claimer: PublicKey,
    claimerTokenAccount: PublicKey,
    initializerDepositTokenAccount: PublicKey,
    initializerAmount: BN,
    mint: PublicKey,
    expiry: BN
}

export const getEscrow: (paymentHash: Buffer) => Promise<EscrowStateType> = async (paymentHash: Buffer): Promise<EscrowStateType> => {
    let escrowState;
    try {
        escrowState = await SwapProgram.account.escrowState.fetch(SwapEscrowState(paymentHash));
    } catch (e) {
        const error = e as Error;
        if(error.message.startsWith("Account does not exist or has no data")) {
            return null;
        }
        throw error;
    }
    return escrowState;
};

export type RefundSignatureResponse = {
    prefix: string,
    timeout: string,
    signature: string
};

export type InitSignatureData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,
    kind?: number,
    confirmations?: number
};

export type InitSignatureResponse = {
    nonce: number,
    prefix: string,
    timeout: string,
    signature: string
};
