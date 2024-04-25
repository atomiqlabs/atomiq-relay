import * as BN from "bn.js";

export type ConfigParser<T> = (data: string) => T;

export type ConfigTemplate<T extends {[key: string]: any}> = {
    [key in keyof T]: ConfigParser<T[key]>
};

export type ParsedConfig<V, T extends ConfigTemplate<V>> = {
    [key in keyof T]: ReturnType<T[key]>
};

export const numberParser: (decimal: boolean, min?: number, max?: number, optional?: boolean) => ConfigParser<number>  = (decimal: boolean, min?: number, max?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: number = decimal ? parseFloat(data) : parseInt(data);
    if(num==null || isNaN(num)) throw new Error("Number is NaN or null");
    if(min!=null && num<min) throw new Error("Number must be greater than "+min);
    if(max!=null && num>max) throw new Error("Number must be less than "+max);
    return num;
};

export const bnParser: (min?: BN, max?: BN, optional?: boolean) => ConfigParser<BN>  = (min?: BN, max?: BN, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: BN = new BN(data);
    if(num==null) throw new Error("Number is NaN or null");
    if(min!=null && num.lt(min)) throw new Error("Number must be greater than "+min.toString(10));
    if(max!=null && num.gt(max)) throw new Error("Number must be less than "+max.toString(10));
    return num;
};

export const enumParser: (possibleValues: string[], optional?: boolean) => ConfigParser<typeof possibleValues[number]> = (possibleValues: string[], optional?: boolean) => {
    const set = new Set(possibleValues);
    return (data: string) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(!set.has(data)) throw new Error("Invalid enum value, possible values: "+possibleValues.join(", "));
        return data;
    };
};

export const stringParser: (minLength?: number, maxLength?: number, optional?: boolean) => ConfigParser<string> = (minLength?: number, maxLength?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(minLength!=null && data.length<minLength) throw new Error("Invalid string length, min length: "+minLength);
    if(maxLength!=null && data.length>maxLength) throw new Error("Invalid string length, max length: "+maxLength);
    return data;
};

export function parseConfig<V, T extends ConfigTemplate<V>>(data: any, template: T): ParsedConfig<V, T> {
    let obj: any = {};
    for(let key in template) {
        const value = data[key];
        try {
            const parsed = template[key](value);
            obj[key] = parsed;
        } catch (e) {
            throw new Error("Error parsing config, option: "+key+" error: "+e.message);
        }
    }
    return obj;
}
