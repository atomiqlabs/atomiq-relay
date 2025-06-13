import {ChainInitializer} from "../ChainInitializer";
import {
    numberParser,
    objectParser,
    stringParser,
    enumParser
} from "@atomiqlabs/server-base";
import {
    RpcProviderWithRetries,
    StarknetBtcRelay, StarknetChainInterface,
    StarknetChainType,
    StarknetFees,
    StarknetSigner, StarknetSpvVaultContract, StarknetSpvVaultData,
    StarknetSwapContract
} from "@atomiqlabs/chain-starknet";
import {getStarknetSigner} from "./signer/StarknetSigner";
import {constants, RpcProvider} from "starknet";
import {StarknetChainEvents} from "@atomiqlabs/chain-starknet/dist/starknet/events/StarknetChainEvents";
import {RootTemplate} from "../RootTemplate";

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    MAX_L1_FEE_GWEI: numberParser(false, 0),
    MAX_L2_FEE_GWEI: numberParser(false, 0),
    MAX_L1_DATA_FEE_GWEI: numberParser(false, 0),
    CHAIN: enumParser(["MAIN", "SEPOLIA"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true)
} as const;

export const StarknetChainInitializer: ChainInitializer<StarknetChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc, bitcoinNetwork) => {
        const chainId = configuration.CHAIN==="MAIN" ? constants.StarknetChainId.SN_MAIN : constants.StarknetChainId.SN_SEPOLIA;

        const provider = new RpcProviderWithRetries({nodeUrl: configuration.RPC_URL});
        console.log("Init provider: ", provider);
        const starknetSigner = getStarknetSigner(configuration, provider);

        const starknetFees = new StarknetFees(provider, {
            l1GasCost: BigInt(configuration.MAX_L1_FEE_GWEI)*1000000000n,
            l2GasCost: BigInt(configuration.MAX_L2_FEE_GWEI)*1000000000n,
            l1DataGasCost: BigInt(configuration.MAX_L1_DATA_FEE_GWEI)*1000000000n,
        });

        const chain = new StarknetChainInterface(chainId, provider, undefined, starknetFees);

        const btcRelay = new StarknetBtcRelay(
            chain, bitcoinRpc, bitcoinNetwork
        );

        const swapContract = new StarknetSwapContract(
            chain, btcRelay
        );

        const spvVaultContract = new StarknetSpvVaultContract(
            chain, btcRelay, bitcoinRpc
        );

        const chainEvents = new StarknetChainEvents(
            directory, chain, swapContract, spvVaultContract
        );

        const signer = new StarknetSigner(starknetSigner);

        return {
            chainId: "STARKNET",
            signer,
            swapContract,
            chainEvents,
            chain,
            spvVaultContract,
            spvVaultDataCtor: StarknetSpvVaultData,
            btcRelay,
            nativeToken: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
            nativeTokenDecimals: 18,
            commands: []
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }, true)
};