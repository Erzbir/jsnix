import {OP_FLAG} from "./fs.js";
import {syscall, SYSCALL_NO} from "./sys/syscall.js";

export const GROUP_PATH = "/etc/group";
const GROUP_CACHE = new Map();

export class Group {
    constructor(name, password, gid, members) {
        this.name = name;
        this.password = password;
        this.gid = gid;
        this.members = members;
    }

    toString() {
        return `${this.name}:${this.password}:${this.gid}:${this.members.join(',')}`;
    }

    static fromString(line) {
        const parts = line.split(":");
        if (parts.length < 4) return null;
        return new Group(
            parts[0],
            parts[1],
            parseInt(parts[2]),
            parts[3] ? parts[3].split(",").filter(m => m) : []
        );
    }
}

function parseGroupFile(content) {
    const lines = content.trim().split('\n');
    const result = [];

    for (const line of lines) {
        if (line.trim() === '' || line.startsWith('#')) continue;

        const [name, password, gid, members] = line.split(':');
        result.push(new Group(
            name,
            password,
            parseInt(gid, 10),
            members ? members.split(',').filter(m => m.trim() !== '') : []
        ));
    }

    return result;
}

function loadGroupCache() {
    const fd = syscall(SYSCALL_NO.__NR_open, GROUP_PATH, OP_FLAG.O_RDONLY);

    if (fd < 0) return;

    const content = syscall(SYSCALL_NO.__NR_read, fd);

    syscall(SYSCALL_NO.__NR_close, fd);

    const entries = parseGroupFile(content);

    GROUP_CACHE.clear();

    for (const entry of entries) {
        GROUP_CACHE.set(entry.gid, entry);
    }
}


/**
 * @param {number} gid
 * @returns {Group}
 */
export function getgrgid(gid) {
    loadGroupCache()
    return GROUP_CACHE.get(gid);
}

/**
 * @param {string} name
 * @returns {Group}
 */
export function getgrnam(name) {
    loadGroupCache();

    for (const entry of GROUP_CACHE.values()) {
        if (entry.name === name) {
            return entry;
        }
    }
}