import * as fs from "fs";
import {HDNodeWallet, BaseWallet, SigningKey} from "ethers";

export function getEVMSigner(configuration: {MNEMONIC_FILE?: string, PRIVKEY?: string}): BaseWallet {
    const mnemonicFile = configuration.MNEMONIC_FILE;
    let privKey = configuration.PRIVKEY;

    if(privKey==null && mnemonicFile==null) {
        throw new Error("Private key or mnemonic phrase file needs to be set!");
    }

    if(mnemonicFile!=null) {
        const mnemonic: string = fs.readFileSync(mnemonicFile).toString();
        return HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1");
    }

    return new BaseWallet(new SigningKey(privKey));
}
