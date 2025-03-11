import {ChainInitializer} from "../ChainInitializer";
import {
    SolanaBtcRelay, SolanaChainType,
    SolanaFees,
    SolanaSigner,
    SolanaSwapProgram,
    StoredDataAccount
} from "@atomiqlabs/chain-solana";
import {
    bigIntParser,
    createCommand,
    numberParser,
    objectParser,
    stringParser,
    ConfigParser, enumParser
} from "@atomiqlabs/server-base";
import * as BN from "bn.js";
import {getSolanaSigner} from "./signer/AnchorSigner";
import {SolanaChainEvents} from "@atomiqlabs/chain-solana/dist/solana/events/SolanaChainEvents";
import {PublicKey} from "@solana/web3.js";
import { StorageManager } from "../../storagemanager/StorageManager";
import {RootTemplate} from "../RootTemplate";

export const publicKeyParser: (optional?: boolean) => ConfigParser<PublicKey> = (optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
    return new PublicKey(data);
};

const template = {
    ...RootTemplate,
    RPC_URL: stringParser(),
    MAX_FEE_MICRO_LAMPORTS: numberParser(false, 1000),

    MNEMONIC_FILE: stringParser(null, null, true),
    PRIVKEY: stringParser(128, 128, true),
    ADDRESS: publicKeyParser(true),

    JITO: objectParser({
        PUBKEY: publicKeyParser(),
        ENDPOINT: stringParser(),
    }, null, true),

    STATIC_TIP: bigIntParser(0n, null, true),
    HELIUS_FEE_LEVEL: enumParser(["min", "low", "medium", "high", "veryHigh", "unsafeMax"], true),
} as const;

export const SolanaChainInitializer: ChainInitializer<SolanaChainType, any, typeof template> = {
    loadChain: (directory, configuration, bitcoinRpc) => {
        const AnchorSigner = getSolanaSigner(configuration);

        const solanaFees = new SolanaFees(
            AnchorSigner.connection,
            configuration.MAX_FEE_MICRO_LAMPORTS,
            8,
            100,
            "auto",
            configuration.HELIUS_FEE_LEVEL ?? "veryHigh",
            configuration.STATIC_TIP!=null ? () => configuration.STATIC_TIP : null,
            configuration.JITO!=null ? {
                address: configuration.JITO.PUBKEY.toString(),
                endpoint: configuration.JITO.ENDPOINT
            } : null
        );

        const btcRelay = new SolanaBtcRelay(
            AnchorSigner.connection,
            bitcoinRpc, process.env.BTC_RELAY_CONTRACT_ADDRESS,
            solanaFees
        );
        const swapContract = new SolanaSwapProgram(
            AnchorSigner.connection,
            btcRelay,
            new StorageManager<StoredDataAccount>(directory+"/solaccounts"),
            process.env.SWAP_CONTRACT_ADDRESS,
            null,
            solanaFees
        );
        const chainEvents = new SolanaChainEvents(directory, AnchorSigner.connection, swapContract);

        return {
            chainId: "SOLANA",
            signer: new SolanaSigner(AnchorSigner.wallet, AnchorSigner.signer),
            swapContract,
            chainEvents,
            btcRelay,
            nativeToken: swapContract.getNativeCurrencyAddress(),
            nativeTokenDecimals: 9,
            commands: [
                createCommand(
                    "airdrop",
                    "Requests an airdrop of SOL tokens (only works on devnet!)",
                    {
                        args: {},
                        parser: async (args, sendLine) => {
                            let signature = await AnchorSigner.connection.requestAirdrop(AnchorSigner.publicKey, 1500000000);
                            sendLine("Transaction sent, signature: "+signature+" waiting for confirmation...");
                            const latestBlockhash = await AnchorSigner.connection.getLatestBlockhash();
                            await AnchorSigner.connection.confirmTransaction(
                                {
                                    signature,
                                    ...latestBlockhash,
                                },
                                "confirmed"
                            );
                            return "Airdrop transaction confirmed!";
                        }
                    }
                )
            ],
            shouldClaimCbk: async (swap) => {
                const claimerBounty = swap.swapData.getClaimerBounty();
                const ataInitFee = await swapContract.Tokens.getATARentExemptLamports();
                const leavesFee = claimerBounty - ataInitFee;
                if(leavesFee > 0n) {
                    return {
                        initAta: true,
                        feeRate: null
                    }
                } else if(claimerBounty > 0n) {
                    return {
                        initAta: false,
                        feeRate: null
                    }
                } else {
                    return null;
                }
            }
        };
    },
    configuration: objectParser(template, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }, true)
};