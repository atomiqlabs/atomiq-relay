import {
    arrayParser,
    booleanParser,
    enumParser,
    numberParser,
    objectParser,
    parseConfig,
    stringParser
} from "@atomiqlabs/server-base";
import * as fs from "fs";
import {parse} from "yaml";
import {RegisteredChains} from "./chains/ChainInitializer";

function getConfigs<T extends { [key: string]: { configuration: any } }>(chainData: T): { [K in keyof T]: T[K]['configuration'] } {
    const result = {} as { [K in keyof T]: T[K]['configuration'] };
    for (const key in chainData) {
        result[key] = chainData[key].configuration;
    }
    return result;
}

const BtcRelayConfigTemplate = {
    ...getConfigs(RegisteredChains),

    BTC_PROTOCOL: enumParser(["http", "https"]),
    BTC_NETWORK: enumParser(["mainnet", "testnet", "testnet4", "regtest"]),
    BTC_PORT: numberParser(false, 0, 65535),
    ZMQ_PORT: numberParser(false, 0, 65535),
    BTC_HOST: stringParser(),
    BTC_RPC_USERNAME: stringParser(),
    BTC_RPC_PASSWORD: stringParser(),

    NOSTR_RELAYS: arrayParser(stringParser(), true),

    CLI_ADDRESS: stringParser(),
    CLI_PORT: numberParser(false, 0, 65535),
    RPC_ADDRESS: stringParser(null, null, true),
    RPC_PORT: numberParser(false, 0, 65535, true),

    WATCHTOWERS: objectParser({
        LEGACY_SWAPS: booleanParser(true),
        SPV_SWAPS: booleanParser(true),
        HTLC_SWAPS: booleanParser(true)
    }, undefined, true)
};

export let BtcRelayConfig = parseConfig(parse(fs.readFileSync(process.env.CONFIG_FILE).toString()), BtcRelayConfigTemplate);
