import {BitcoinRpc, ChainType} from "@atomiqlabs/base";
import {ConfigParser, ConfigTemplate, ParsedConfig, Command} from "@atomiqlabs/server-base";
import {SolanaChainInitializer} from "./solana/SolanaChainInitializer";
import {StarknetChainInitializer} from "./starknet/StarknetChainInitializer";
import {SavedSwap} from "@atomiqlabs/watchtower-lib/dist/watchtower/SavedSwap";

export type ChainData<T extends ChainType = ChainType> = {
    chainId: T["ChainId"],
    signer: T["Signer"],
    swapContract: T["Contract"],
    spvVaultContract?: T["SpvVaultContract"],
    spvVaultDataCtor?: new (obj: any) => T["SpvVaultData"],
    chain: T["ChainInterface"],
    chainEvents: T["Events"],
    btcRelay: T["BtcRelay"],
    nativeToken: string,
    nativeTokenDecimals: number,
    commands?: Command<any>[],
    shouldClaimCbk?: (savedSwap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
};

export type ChainInitializer<T extends ChainType, C, V extends ConfigTemplate<C>> = {
    loadChain: (directory: string, configuration: ParsedConfig<C, V>, bitcoinRpc: BitcoinRpc<any>) => ChainData<T>,
    configuration: ConfigParser<ParsedConfig<C, V>>
};

export const RegisteredChains = {
    SOLANA: SolanaChainInitializer,
    STARKNET: StarknetChainInitializer
}
