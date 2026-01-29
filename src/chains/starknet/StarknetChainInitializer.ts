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
    StarknetSpvVaultContract, StarknetSpvVaultData,
    StarknetSwapContract, StarknetSwapData, WebSocketChannelWithRetries
} from "@atomiqlabs/chain-starknet";
import {getStarknetSigner} from "./signer/StarknetSigner";
import {constants, RpcProvider} from "starknet";
import {StarknetChainEvents} from "@atomiqlabs/chain-starknet/dist/starknet/events/StarknetChainEvents";
import {RootTemplate} from "../RootTemplate";
import {ChainSwapType} from "@atomiqlabs/base";
import {StarknetPersistentSigner} from "@atomiqlabs/chain-starknet/dist/starknet/wallet/StarknetPersistentSigner";

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    WS_URL: stringParser(undefined, undefined, true),
    MAX_L1_FEE_GWEI: numberParser(false, 0),
    MAX_L2_FEE_GWEI: numberParser(false, 0),
    MAX_L1_DATA_FEE_GWEI: numberParser(false, 0),
    CHAIN: enumParser(["MAIN", "SEPOLIA"]),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(66, 66, true),

    CONTRACTS: objectParser({
        BTC_RELAY: stringParser(3, 66, true),
        ESCROW: stringParser(3, 66, true),
        SPV_VAULT: stringParser(3, 66, true),

        TIMELOCK_REFUND_HANDLER: stringParser(3, 66, true),

        HASHLOCK_CLAIM_HANDLER: stringParser(3, 66, true),
        BTC_TXID_CLAIM_HANDLER: stringParser(3, 66, true),
        BTC_OUTPUT_CLAIM_HANDLER: stringParser(3, 66, true),
        BTC_NONCED_OUTPUT_CLAIM_HANDLER: stringParser(3, 66, true),
    }, null, true)
} as const;

export const StarknetChainInitializer: ChainInitializer<StarknetChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc, bitcoinNetwork) => {
        const chainId = configuration.CHAIN==="MAIN" ? constants.StarknetChainId.SN_MAIN : constants.StarknetChainId.SN_SEPOLIA;

        const provider = new RpcProviderWithRetries({nodeUrl: configuration.RPC_URL});
        const wsChannel = configuration.WS_URL==null ? null : new WebSocketChannelWithRetries({nodeUrl: configuration.WS_URL, reconnectOptions: {delay: 2000, retries: Infinity}});
        console.log("Init provider: ", provider);
        const starknetSigner = getStarknetSigner(configuration, provider);

        const starknetFees = new StarknetFees(provider, {
            l1GasCost: BigInt(configuration.MAX_L1_FEE_GWEI)*1000000000n,
            l2GasCost: BigInt(configuration.MAX_L2_FEE_GWEI)*1000000000n,
            l1DataGasCost: BigInt(configuration.MAX_L1_DATA_FEE_GWEI)*1000000000n,
        });

        const chain = new StarknetChainInterface(chainId, provider, wsChannel, starknetFees);

        const btcRelay = new StarknetBtcRelay(
            chain, bitcoinRpc, bitcoinNetwork, configuration.CONTRACTS?.BTC_RELAY
        );

        const claimHandlers = {};
        if(configuration.CONTRACTS?.HASHLOCK_CLAIM_HANDLER!=null) claimHandlers[ChainSwapType.HTLC] = configuration.CONTRACTS?.HASHLOCK_CLAIM_HANDLER;
        if(configuration.CONTRACTS?.BTC_TXID_CLAIM_HANDLER!=null) claimHandlers[ChainSwapType.CHAIN_TXID] = configuration.CONTRACTS?.BTC_TXID_CLAIM_HANDLER;
        if(configuration.CONTRACTS?.BTC_OUTPUT_CLAIM_HANDLER!=null) claimHandlers[ChainSwapType.CHAIN] = configuration.CONTRACTS?.BTC_OUTPUT_CLAIM_HANDLER;
        if(configuration.CONTRACTS?.BTC_NONCED_OUTPUT_CLAIM_HANDLER!=null) claimHandlers[ChainSwapType.CHAIN_NONCED] = configuration.CONTRACTS?.BTC_NONCED_OUTPUT_CLAIM_HANDLER;

        const refundHandlers: {timelock?: string} = {};
        if(configuration.CONTRACTS?.TIMELOCK_REFUND_HANDLER!=null) refundHandlers.timelock = configuration.CONTRACTS.TIMELOCK_REFUND_HANDLER

        const swapContract = new StarknetSwapContract(
            chain, btcRelay, configuration.CONTRACTS?.ESCROW,
            {
                refund: refundHandlers,
                claim: claimHandlers
            }
        );

        const spvVaultContract = new StarknetSpvVaultContract(
            chain, btcRelay, bitcoinRpc, configuration.CONTRACTS?.SPV_VAULT
        );

        const chainEvents = new StarknetChainEvents(
            directory, chain, swapContract, spvVaultContract, wsChannel!=null ? 30 : undefined
        );

        const signer = new StarknetPersistentSigner(starknetSigner, chain, directory+"/wallet");

        return {
            chainId: "STARKNET",
            signer,
            swapContract,
            swapDataClass: StarknetSwapData,
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