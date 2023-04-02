import Lockable from "./Lockable";

class SavedSwap extends Lockable {

    readonly txoHash: Buffer;
    readonly hash: Buffer;
    readonly confirmations: number;

    constructor(data: any);
    constructor(txoHash: Buffer, hash: Buffer, confirmations: number);

    constructor(txoHashOrObj: Buffer | any, hash?: Buffer, confirmations?: number) {
        super();
        if(hash!=null || confirmations!=null) {
            this.txoHash = txoHashOrObj;
            this.hash = hash;
            this.confirmations = confirmations;
        } else {
            this.txoHash = Buffer.from(txoHashOrObj.txoHash, "hex");
            this.hash = Buffer.from(txoHashOrObj.hash, "hex");
            this.confirmations = txoHashOrObj.confirmations;
        }
    }

    serialize(): any {
        return {
            txoHash: this.txoHash.toString("hex"),
            hash: this.hash.toString("hex"),
            confirmations: this.confirmations,
        }
    }

}

export default SavedSwap;