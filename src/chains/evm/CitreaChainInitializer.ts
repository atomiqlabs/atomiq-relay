import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser
} from "@atomiqlabs/server-base";
import {RootTemplate} from "../RootTemplate";
import {
    initializeCitrea,
    CitreaChainType,
    EVMSigner,
    EVMSpvVaultData,
    CitreaFees, EVMSwapData, JsonRpcProviderWithRetries
} from "@atomiqlabs/chain-evm";
import {JsonRpcProvider} from "ethers";
import {getEVMSigner} from "./signer/BaseEVMSigner";
import {EVMChainEvents} from "@atomiqlabs/chain-evm/dist/evm/events/EVMChainEvents";

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    MAX_LOGS_BLOCK_RANGE: numberParser(false, 1, undefined, true),
    MAX_FEE_GWEI: numberParser(true, 0),
    FEE_TIP_GWEI: numberParser(true, 0, undefined, true),
    CHAIN: enumParser(["MAINNET", "TESTNET4"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true)
} as const;

export const CitreaChainInitializer: ChainInitializer<CitreaChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc, bitcoinNetwork) => {
        const provider = new JsonRpcProviderWithRetries(configuration.RPC_URL);

        const {chainInterface, btcRelay, swapContract, spvVaultContract} = initializeCitrea({
            rpcUrl: provider,
            chainType: configuration.CHAIN,
            maxLogsBlockRange: configuration.MAX_LOGS_BLOCK_RANGE,
            fees: new CitreaFees(
                provider,
                BigInt(Math.floor(configuration.MAX_FEE_GWEI * 1_000_000_000)),
                configuration.FEE_TIP_GWEI==null ? undefined : BigInt(Math.floor(configuration.FEE_TIP_GWEI * 1_000_000_000))
            )
        }, bitcoinRpc, bitcoinNetwork);

        console.log("Init provider: ", provider);
        const evmSigner = getEVMSigner(configuration);

        const chainEvents = new EVMChainEvents(
            directory, chainInterface, swapContract, spvVaultContract
        );

        const signer = new EVMSigner(evmSigner, evmSigner.address);

        return {
            chainId: "CITREA",
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