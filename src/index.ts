import WebSocket from 'ws';

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import {BitcoindRpc} from "@atomiqlabs/btc-bitcoind";
import {BtcRelayConfig} from "./BtcRelayConfig";
import {BtcRelayRunnerWrapper} from "./runner/BtcRelayRunnerWrapper";
import {ChainData, ChainInitializer, RegisteredChains} from "./chains/ChainInitializer";
import {BitcoinNetwork, Messenger} from "@atomiqlabs/base";
import {NostrMessenger} from "@atomiqlabs/messenger-nostr";
import {WatchtowersEnabledType} from "./runner/BtcRelayRunner";

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

    let messenger: Messenger = null;
    if(BtcRelayConfig.WATCHTOWERS?.HTLC_SWAPS) {
        if(BtcRelayConfig.NOSTR_RELAYS==null || BtcRelayConfig.NOSTR_RELAYS.length===0)
            throw new Error("No NOSTR_RELAYS configured in the config, but attempted to start an HTLC watchtower! Configure NOSTR_RELAYS");
        messenger = new NostrMessenger(bitcoinNetwork, BtcRelayConfig.NOSTR_RELAYS, {
            wsImplementation: WebSocket as any
        });
    }

    const registeredChains: {[chainId: string]: ChainInitializer<any, any, any>} = RegisteredChains;
    const chainsData: {[chainId: string]: {data: ChainData, watchtowers: WatchtowersEnabledType}} = {};
    for(let chainId in registeredChains) {
        if(BtcRelayConfig[chainId]==null) continue;
        const directory = process.env.STORAGE_DIR+"/"+chainId;
        const chainData = registeredChains[chainId].loadChain(directory, BtcRelayConfig[chainId], bitcoinRpc, bitcoinNetwork);
        chainsData[chainId] = {
            data: chainData,
            watchtowers: BtcRelayConfig[chainId].WATCHTOWERS
        };
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
    }

    const runner = new BtcRelayRunnerWrapper(
        process.env.STORAGE_DIR, chainsData, bitcoinRpc,
        BtcRelayConfig.BTC_HOST, BtcRelayConfig.ZMQ_PORT, messenger, BtcRelayConfig.WATCHTOWERS,
        BtcRelayConfig.CLI_ADDRESS, BtcRelayConfig.CLI_PORT,
        BtcRelayConfig.RPC_ADDRESS, BtcRelayConfig.RPC_PORT
    );

    console.log("Index: Starting relay: "+BtcRelayConfig.CLI_ADDRESS+":"+BtcRelayConfig.CLI_PORT+"!");
    await runner.init();

}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

global.atomiqLogLevel = 3;
main().catch(e => {
    console.error(e);
});
