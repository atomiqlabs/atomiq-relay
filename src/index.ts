import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "./solana/AnchorSigner";
import * as fs from "fs/promises";
import {SolanaBtcRelay, SolanaFeeEstimator} from "crosslightning-solana";
import {BitcoindBlock, BitcoindRpc, BtcRelaySynchronizer} from "btcrelay-bitcoind";
import * as BN from "bn.js";
import {BtcRelayConfig} from "./BtcRelayConfig";
import {SolanaBtcRelayRunnerWrapper} from "./runner/SolanaBtcRelayRunnerWrapper";


async function main() {

    try {
        await fs.mkdir("storage")
    } catch (e) {}

    const bitcoinRpc = new BitcoindRpc(
        BtcRelayConfig.BTC_PROTOCOL,
        BtcRelayConfig.BTC_RPC_USERNAME,
        BtcRelayConfig.BTC_RPC_PASSWORD,
        BtcRelayConfig.BTC_HOST,
        BtcRelayConfig.BTC_PORT
    );
    const btcRelay = new SolanaBtcRelay<BitcoindBlock>(
        AnchorSigner,
        bitcoinRpc,
        process.env.BTC_RELAY_CONTRACT_ADDRESS,
        new SolanaFeeEstimator(
            AnchorSigner.connection,
            100000,
            3,
            150,
            "auto",
            () => BtcRelayConfig.STATIC_TIP==null ? new BN(0) : BtcRelayConfig.STATIC_TIP,
            BtcRelayConfig.JITO_PUBKEY!=null && BtcRelayConfig.JITO_PUBKEY!=="" && BtcRelayConfig.JITO_ENDPOINT!=null && BtcRelayConfig.JITO_ENDPOINT!=="" ? {
                address: BtcRelayConfig.JITO_PUBKEY,
                endpoint: BtcRelayConfig.JITO_ENDPOINT,
            } : null
        )
    );

    const runner = new SolanaBtcRelayRunnerWrapper(AnchorSigner, bitcoinRpc, btcRelay, BtcRelayConfig.BTC_HOST, BtcRelayConfig.ZMQ_PORT);
    await runner.init();

}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => {
    console.error(e);
});
