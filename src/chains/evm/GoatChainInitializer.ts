import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser, booleanParser, arrayParser
} from "@atomiqlabs/server-base";
import {RootTemplate} from "../RootTemplate";
import {
    EVMSpvVaultData,
    GoatChainType,
    initializeGoat,
    EVMFees, EVMSwapData, JsonRpcProviderWithRetries, WebSocketProviderWithRetries
} from "@atomiqlabs/chain-evm";
import {getEVMSigner} from "./signer/BaseEVMSigner";
import {EVMChainEvents} from "@atomiqlabs/chain-evm/dist/evm/events/EVMChainEvents";
import WebSocket from "ws";
import {EVMPersistentSigner} from "@atomiqlabs/chain-evm/dist/evm/wallet/EVMPersistentSigner";

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    MAX_LOGS_BLOCK_RANGE: numberParser(false, 1, undefined, true),
    MAX_LOGS_TOPICS: numberParser(false, 1, undefined, true),
    MAX_LOGS_PARALLEL_REQUESTS: numberParser(false, 1, undefined, true),
    MAX_CALLS_PARALLEL: numberParser(false, 1, undefined, true),

    MAX_FEE_GWEI: numberParser(true, 0),
    FEE_TIP_GWEI: numberParser(true, 0, undefined, true),
    CHAIN: enumParser(["MAINNET", "TESTNET", "TESTNET4"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true),

    USE_ACCESS_LISTS: booleanParser(true),
    ACCESS_LIST_HINTS: arrayParser(stringParser(42, 42), true)
} as const;

export const GoatChainInitializer: ChainInitializer<GoatChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc, bitcoinNetwork) => {
        const provider = configuration.RPC_URL.startsWith("ws")
            ? new WebSocketProviderWithRetries(() => new WebSocket(configuration.RPC_URL))
            : new JsonRpcProviderWithRetries(configuration.RPC_URL);

        const {chainInterface, btcRelay, swapContract, spvVaultContract} = initializeGoat({
            rpcUrl: provider,
            chainType: configuration.CHAIN,
            fees: new EVMFees(
                provider,
                BigInt(Math.floor(configuration.MAX_FEE_GWEI * 1_000_000_000)),
                configuration.FEE_TIP_GWEI==null ? undefined : BigInt(Math.floor(configuration.FEE_TIP_GWEI * 1_000_000_000))
            ),
            evmConfig: {
                maxLogsBlockRange: configuration.MAX_LOGS_BLOCK_RANGE,
                maxLogTopics: configuration.MAX_LOGS_TOPICS,
                maxParallelLogRequests: configuration.MAX_LOGS_PARALLEL_REQUESTS,
                maxParallelCalls: configuration.MAX_CALLS_PARALLEL,
                useAccessLists: configuration.USE_ACCESS_LISTS,
                defaultAccessListAddresses: configuration.ACCESS_LIST_HINTS
            }
        }, bitcoinRpc, bitcoinNetwork);

        console.log("Init provider: ", provider);
        const evmSigner = getEVMSigner(configuration);

        const chainEvents = new EVMChainEvents(
            directory, chainInterface, swapContract, spvVaultContract,
            configuration.RPC_URL.startsWith("ws") ? 30 : undefined //We don't need to check that often when using websocket
        );

        const signer = new EVMPersistentSigner(evmSigner, evmSigner.address, chainInterface, directory+"/wallet", 0n, 200_000n, 15*1000);

        return {
            chainId: "GOAT",
            signer,
            swapContract,
            swapDataClass: EVMSwapData,
            chainEvents,
            chain: chainInterface,
            spvVaultContract,
            spvVaultDataCtor: EVMSpvVaultData,
            btcRelay,
            nativeToken: chainInterface.getNativeCurrencyAddress(),
            nativeTokenDecimals: 18,
            commands: []
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }, true)
};