import {OP_FLAG} from "./fs.js";
import {syscall, SYSCALL_NO} from "./sys/syscall.js";

export const PASSWD_PATH = "/etc/passwd";
const passwdCache = new Map();

export class Passwd {
    constructor(name, passwd, uid, gid, gecos, homedir, shell) {
        this.name = name;
        this.passwd = passwd;
        this.uid = uid;
        this.gid = gid;
        this.gecos = gecos;
        this.homedir = homedir;
        this.shell = shell;
    }

    toString() {
        return `${this.name}:${this.passwd}:${this.uid}:${this.gid}:${this.gecos}:${this.homedir}:${this.shell}`;
    }

    static fromString(line) {
        const parts = line.split(":");
        if (parts.length < 7) return null;
        return new Passwd(
            parts[0],
            parts[1],
            parseInt(parts[2]),
            parseInt(parts[3]),
            parts[4],
            parts[5],
            parts[6]
        );
    }
}


function parsePasswdFile(content) {
    const lines = content.trim().split('\n');
    const result = [];

    for (const line of lines) {
        if (line.trim() === '' || line.startsWith('#')) continue;

        const [name, passwd, uid, gid, gecos, homedir, shell] = line.split(':');
        result.push(new Passwd(
            name,
            passwd,
            parseInt(uid, 10),
            parseInt(gid, 10),
            gecos,
            homedir,
            shell
        ));
    }

    return result;
}

function loadPasswdCache() {
    const fd = syscall(SYSCALL_NO.__NR_open, PASSWD_PATH, OP_FLAG.O_RDONLY);

    if (fd < 0) return;

    const content = syscall(SYSCALL_NO.__NR_read, fd);

    syscall(SYSCALL_NO.__NR_close, fd);

    const entries = parsePasswdFile(content);

    passwdCache.clear();

    for (const entry of entries) {
        passwdCache.set(entry.uid, entry);
    }
}

/**
 * @param {number} uid
 * @returns {Passwd}
 */
export function getpwuid(uid) {
    loadPasswdCache();
    return passwdCache.get(uid);
}

/**
 * @param {string} name
 * @returns {Passwd}
 */
export function getpwnam(name) {
    loadPasswdCache();
    for (const entry of passwdCache.values()) {
        if (entry.name === name) {
            return entry;
        }
    }
}