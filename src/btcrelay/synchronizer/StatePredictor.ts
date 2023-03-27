import {Header, StoredHeader} from "../BtcRelay";

const DIFF_ADJUSTMENT_PERIOD = 2016;

export function gtBuffer(a: Buffer, b: Buffer): boolean {
    for(let i=0;i<a.length;i++) {
        if(a[i]>b[i]) return true;
        if(a[i]<b[i]) return false;
    }
    return false;
}

function divInPlace(arr: Buffer, divisor: number): void {

    let remainder = 0;

    for(let i=0;i<32;i++) {
        const val = arr[i] + remainder;
        const result = Math.floor(val/divisor);
        remainder = (val % divisor) << 8;
        arr[i] = result;
    }

}

function addInPlace(arr: number[], add: number[]): void {

    let remainder = 0;

    for(let i=0;i<32;i++) {
        const pos = 31-i;
        const val = arr[pos] + add[pos] + remainder;
        const byte = val & 0xFF;
        remainder = val >> 8;
        arr[pos] = byte;
    }

}

function nbitsToTarget(nbits: number): Buffer {

    const target = Buffer.alloc(32, 0);

    const nSize = (nbits>>24) & 0xFF;

    const nWord = [
        ((nbits >> 16) & 0x7F),
        ((nbits >> 8) & 0xFF),
        ((nbits) & 0xFF)
    ];

    const start = 32-nSize;

    for(let i=0;i<3;i++) {
        if(start+i<32) {
            target[start+i] = nWord[i];
        }
    }

    return target;

}

function getDifficulty(nbits: number): Buffer {

    const target = nbitsToTarget(nbits);

    let start = 0;
    for(let i=0;i<32;i++) {
        if(target[i]>0) {
            start = i;
            break;
        }
    }

    const shift = 32 - start - 3;

    let num = 0;

    for(let i=0;i<3;i++) {
        num |= target[start+i] << ((2-i)*8);
    }

    const arr = Buffer.from("00000000FFFF0000000000000000000000000000000000000000000000000000", "hex");

    divInPlace(arr, num);

    const result = Buffer.alloc(32, 0);

    for(let i=0;i<32-shift;i++) {
        result[i+shift] = arr[i];
    }

    return result;

}

export function computeCommitedHeader(initialCommitedHeader: StoredHeader, header: Header) {

    const committedHeader = {...initialCommitedHeader};

    committedHeader.chainWork = [...committedHeader.chainWork];
    committedHeader.prevBlockTimestamps = [...committedHeader.prevBlockTimestamps];

    committedHeader.blockheight++;

    for(let i=1;i<10;i++) {
        committedHeader.prevBlockTimestamps[i-1] = committedHeader.prevBlockTimestamps[i];
    }
    committedHeader.prevBlockTimestamps[9] = committedHeader.header.timestamp;

    if(committedHeader.blockheight % DIFF_ADJUSTMENT_PERIOD === 0) {
        committedHeader.lastDiffAdjustment = header.timestamp;
    }

    addInPlace(committedHeader.chainWork, [...getDifficulty(header.nbits)]);

    committedHeader.header = header;

    return committedHeader;

}
