import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../solana/AnchorSigner";
import {BN} from "@coral-xyz/anchor";
import {PublicKey} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram} from "crosslightning-solana";
import {BtcRPCConfig} from "../btc/BtcRPC";
import {BitcoindRpc} from "btcrelay-bitcoind";
import {StorageManager} from "../storagemanager/StorageManager";

const WSOL_ADDRESS = new PublicKey("So11111111111111111111111111111111111111112");

async function withdraw(dstAddress: string, amount: number) {

    let useToken = WSOL_ADDRESS;

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager(""));

    const result = await swapContract.transfer(useToken, new BN(amount), dstAddress, true);

    console.log("Transfer sent: ", result);

    return true;

}

async function main() {
    if(process.argv.length<4) {
        console.error("Needs at least 2 arguments");
        console.error("Usage: node withdraw.js <amount> <dstAddress>");
        return;
    }

    const amount = parseInt(process.argv[2]);
    const dstAddress = process.argv[3];

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    await withdraw(dstAddress, amount);
}

main();