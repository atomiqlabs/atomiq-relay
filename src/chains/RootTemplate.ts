import {booleanParser, numberParser, objectParser, stringParser} from "@atomiqlabs/server-base";

export const RootTemplate = {
    CLI_ADDRESS: stringParser(),
    CLI_PORT: numberParser(false, 0, 65535),

    WATCHTOWERS: objectParser({
        LEGACY_SWAPS: booleanParser(true),
        SPV_SWAPS: booleanParser(true),
        HTLC_SWAPS: booleanParser(true)
    }, undefined, true)
} as const;