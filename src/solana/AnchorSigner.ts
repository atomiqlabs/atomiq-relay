import {AnchorProvider, Wallet} from "@coral-xyz/anchor";
import {Connection, Keypair} from "@solana/web3.js";
import {BtcRelayConfig} from "../BtcRelayConfig";
import * as bip39 from "bip39";
import { derivePath } from 'ed25519-hd-key';
import * as fs from "fs";

const mnemonicFile = BtcRelayConfig.SOL_MNEMONIC_FILE;
const privKey = BtcRelayConfig.SOL_PRIVKEY;
const address = BtcRelayConfig.SOL_ADDRESS;

if(privKey==null && mnemonicFile==null) {
    throw new Error("Private key or mnemonic phrase file needs to be set!");
}

let _signer: Keypair;

if(privKey!=null) {
    _signer = Keypair.fromSecretKey(Buffer.from(privKey, "hex"));
}

if(mnemonicFile!=null) {
    const mnemonic: string = fs.readFileSync(mnemonicFile).toString();
    let seed: Buffer;
    try {
        seed = bip39.mnemonicToSeedSync(mnemonic);
    } catch (e) {
        throw new Error("Error parsing mnemonic phrase!");
    }
    const path44Acc1 = "m/44'/501'/1'/0'";
    const derivedPath = derivePath(path44Acc1, seed.toString("hex"));
    _signer = Keypair.fromSeed(derivedPath.key);
}


const connection = new Connection(BtcRelayConfig.SOL_RPC_URL, "processed");
const AnchorSigner: (AnchorProvider & {signer: Keypair}) = new AnchorProvider(connection, new Wallet(_signer), {
    preflightCommitment: "processed"
}) as any;

AnchorSigner.signer = _signer;

export default AnchorSigner;