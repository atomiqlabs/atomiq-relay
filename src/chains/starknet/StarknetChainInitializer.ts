import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser
} from "@atomiqlabs/server-base";
import {
    StarknetBtcRelay,
    StarknetChainType,
    StarknetFees,
    StarknetSigner,
    StarknetSwapContract
} from "@atomiqlabs/chain-starknet";
import {getStarknetSigner} from "./signer/StarknetSigner";
import {constants, RpcProvider} from "starknet";
import {StarknetChainEvents} from "@atomiqlabs/chain-starknet/dist/starknet/events/StarknetChainEvents";
import {RootTemplate} from "../RootTemplate";

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    MAX_FEE_GWEI: numberParser(false, 0),
    FEE_TOKEN: enumParser(["STRK", "ETH"]),
    CHAIN: enumParser(["MAIN", "SEPOLIA"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true)
} as const;

export const StarknetChainInitializer: ChainInitializer<StarknetChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc) => {
        const chainId = configuration.CHAIN==="MAIN" ? constants.StarknetChainId.SN_MAIN : constants.StarknetChainId.SN_SEPOLIA;

        const provider = new RpcProvider({nodeUrl: configuration.RPC_URL});
        const starknetSigner = getStarknetSigner(configuration, provider);

        const starknetFees = new StarknetFees(provider, configuration.FEE_TOKEN, configuration.MAX_FEE_GWEI*1000000000);

        const btcRelay = new StarknetBtcRelay(
            chainId, provider, bitcoinRpc, undefined, undefined, starknetFees
        );

        const swapContract = new StarknetSwapContract(
            chainId, provider, btcRelay, undefined, undefined, starknetFees
        );

        const chainEvents = new StarknetChainEvents(directory, swapContract);

        const signer = new StarknetSigner(starknetSigner);

        return {
            chainId: "STARKNET",
            signer,
            swapContract,
            chainEvents,
            btcRelay,
            nativeToken: configuration.FEE_TOKEN==="ETH" ?
                "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" :
                "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
            nativeTokenDecimals: 18,
            commands: []
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }, true)
};