import {numberParser, stringParser} from "@atomiqlabs/server-base";

export const RootTemplate = {
    CLI_ADDRESS: stringParser(),
    CLI_PORT: numberParser(false, 0, 65535)
} as const;