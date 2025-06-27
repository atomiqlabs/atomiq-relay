import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";
import {BtcRelayConfig} from "./BtcRelayConfig";
import {BtcRelayRunnerWrapper} from "./runner/BtcRelayRunnerWrapper";
import {ChainInitializer, RegisteredChains} from "./chains/ChainInitializer";
import {BitcoinNetwork} from "@atomiqlabs/base";

async function main() {
    try {
        await fs.mkdir(process.env.STORAGE_DIR)
    } catch (e) {}

    const bitcoinRpc = new BitcoindRpc(
        BtcRelayConfig.BTC_PROTOCOL,
        BtcRelayConfig.BTC_RPC_USERNAME,
        BtcRelayConfig.BTC_RPC_PASSWORD,
        BtcRelayConfig.BTC_HOST,
        BtcRelayConfig.BTC_PORT
    );

    const bitcoinNetwork: BitcoinNetwork = BitcoinNetwork[BtcRelayConfig.BTC_NETWORK.toUpperCase()];

    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    for(let chainId in registeredChains) {
        if(BtcRelayConfig[chainId]==null) continue;
        const directory = process.env.STORAGE_DIR+"/"+chainId;
        const chainData = registeredChains[chainId].loadChain(directory, BtcRelayConfig[chainId], bitcoinRpc, bitcoinNetwork);
        try {
            await fs.mkdir(directory);
        } catch (e) {}
        const runner = new BtcRelayRunnerWrapper(
            directory, chainData, bitcoinRpc,
            BtcRelayConfig.BTC_HOST, BtcRelayConfig.ZMQ_PORT,
            BtcRelayConfig[chainId].CLI_ADDRESS, BtcRelayConfig[chainId].CLI_PORT
        );
        console.log("Index: Starting "+chainId+" relay: "+BtcRelayConfig[chainId].CLI_ADDRESS+":"+BtcRelayConfig[chainId].CLI_PORT+"!");
        runner.init().then(() => {
            console.log("Index: "+chainId+" relay started and initialized!");
        }).catch(e => {
            console.error("Index: "+chainId+" relay couldn't be started: ",e);
            process.exit();
        })
    }

}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => {
    console.error(e);
});
