import * as BN from "bn.js";
import {bnParser, enumParser, numberParser, parseConfig, stringParser} from "crosslightning-server-base";
import * as fs from "fs";
import {parse} from "yaml";

const BtcRelayConfigTemplate = {
    BTC_PROTOCOL: enumParser(["http", "https"]),
    BTC_PORT: numberParser(false, 0, 65535),
    ZMQ_PORT: numberParser(false, 0, 65535),
    BTC_HOST: stringParser(),
    BTC_RPC_USERNAME: stringParser(),
    BTC_RPC_PASSWORD: stringParser(),

    JITO_PUBKEY: stringParser(null, null, true),
    JITO_ENDPOINT: stringParser(null, null, true),

    STATIC_TIP: bnParser(new BN(0), null, true),

    SOL_RPC_URL: stringParser(),

    SOL_MNEMONIC_FILE: stringParser(null, null, true),
    SOL_PRIVKEY: stringParser(128, 128, true),
    SOL_ADDRESS: stringParser(null, null, true)
};

export let BtcRelayConfig = parseConfig(parse(fs.readFileSync(process.env.CONFIG_FILE).toString()), BtcRelayConfigTemplate);
