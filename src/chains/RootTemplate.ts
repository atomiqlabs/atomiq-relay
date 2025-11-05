import {booleanParser, objectParser} from "@atomiqlabs/server-base";

export const RootTemplate = {
    WATCHTOWERS: objectParser({
        LEGACY_SWAPS: booleanParser(true),
        SPV_SWAPS: booleanParser(true),
        HTLC_SWAPS: booleanParser(true)
    }, undefined, true)
} as const;