import WebSocket from 'ws';

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";
import {BtcRelayConfig} from "./BtcRelayConfig";
import {BtcRelayRunnerWrapper} from "./runner/BtcRelayRunnerWrapper";
import {ChainInitializer, RegisteredChains} from "./chains/ChainInitializer";
import {BitcoinNetwork, Messenger} from "@atomiqlabs/base";
import {NostrMessenger} from "@atomiqlabs/messenger-nostr";

async function main() {
    // //@ts-ignore
    // const { useWebSocketImplementation: useWsRelay } = await import('nostr-tools/relay');
    // useWsRelay(WebSocket);
    // //@ts-ignore
    // const { useWebSocketImplementation: useWsPool } = await import('nostr-tools/pool');
    // useWsPool(WebSocket);

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

    let messenger: Messenger = null;

    const bitcoinNetwork: BitcoinNetwork = BitcoinNetwork[BtcRelayConfig.BTC_NETWORK.toUpperCase()];

    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    for(let chainId in registeredChains) {
        if(BtcRelayConfig[chainId]==null) continue;
        const directory = process.env.STORAGE_DIR+"/"+chainId;
        const chainData = registeredChains[chainId].loadChain(directory, BtcRelayConfig[chainId], bitcoinRpc, bitcoinNetwork);
        try {
            await fs.mkdir(directory);
        } catch (e) {}
        if(BtcRelayConfig[chainId].WATCHTOWERS?.HTLC_SWAPS && messenger==null) {
            if(BtcRelayConfig.NOSTR_RELAYS==null || BtcRelayConfig.NOSTR_RELAYS.length===0)
                throw new Error("No NOSTR_RELAYS configured in the config, but attempted to start an HTLC watchtower! Configure NOSTR_RELAYS");
            messenger = new NostrMessenger(bitcoinNetwork, BtcRelayConfig.NOSTR_RELAYS, {
                wsImplementation: WebSocket as any
            });
        }
        const runner = new BtcRelayRunnerWrapper(
            directory, chainData, bitcoinRpc,
            BtcRelayConfig.BTC_HOST, BtcRelayConfig.ZMQ_PORT, messenger, BtcRelayConfig[chainId].WATCHTOWERS,
            BtcRelayConfig[chainId].CLI_ADDRESS, BtcRelayConfig[chainId].CLI_PORT,
            BtcRelayConfig[chainId].RPC_ADDRESS, BtcRelayConfig[chainId].RPC_PORT
        );
        console.log("Index: Starting "+chainId+" relay: "+BtcRelayConfig[chainId].CLI_ADDRESS+":"+BtcRelayConfig[chainId].CLI_PORT+"!");
        runner.init().then(() => {
            console.log("Index: "+chainId+" relay started and initialized!");
        }).catch(e => {
            console.error("Index: "+chainId+" relay couldn't be started: ",e);
            process.exit();
        });
    }

}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

global.atomiqLogLevel = 3;
main().catch(e => {
    console.error(e);
});
