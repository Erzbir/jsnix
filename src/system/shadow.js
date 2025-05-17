import {readFile} from "./fs.js";

export const SHADOW_PATH = "/etc/shadow"
export const GSHADOW_PATH = "/etc/gshadow"

export class Shadow {
    constructor(name, password, lastChanged = '', minDays = '0', maxDays = '99999', warnDays = '7', inactiveDays = '', expireDate = '') {
        this.name = name;
        this.password = password;
        this.lastChanged = lastChanged;
        this.minDays = minDays;
        this.maxDays = maxDays;
        this.warnDays = warnDays;
        this.inactiveDays = inactiveDays;
        this.expireDate = expireDate;
        this.reserved = '';
    }

    static fromString(line) {
        const parts = line.split(":");
        if (parts.length < 9) return null;
        return new Shadow(
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
            parts[5],
            parts[6],
            parts[7]
        );
    }

    toString() {
        return `${this.name}:${this.password}:${this.lastChanged}:${this.minDays}:${this.maxDays}:${this.warnDays}:${this.inactiveDays}:${this.expireDate}:${this.reserved}`;
    }
}

export class GShadow {
    constructor(name, password, administrators = [], members = []) {
        this.name = name;
        this.password = password;
        this.administrators = Array.isArray(administrators) ? administrators : [administrators];
        this.members = Array.isArray(members) ? members : [members];
    }

    static fromString(line) {
        const parts = line.split(":");
        if (parts.length < 4) return null;
        return new GShadow(
            parts[0],
            parts[1],
            parts[2] ? parts[2].split(",").filter(m => m) : [],
            parts[3] ? parts[3].split(",").filter(m => m) : []
        );
    }

    toString() {
        return `${this.name}:${this.password}:${this.administrators.join(",")}:${this.members.join(",")}`;
    }
}

export function getspnam(name) {

    const data = readFile(SHADOW_PATH);
    return data.split('\n')
        .filter(line => line.trim())
        .map(line => Shadow.fromString(line))
        .filter(entry => entry && entry.name === name)[0];

}