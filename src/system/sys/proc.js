let a_pid = 1;

export class PCB {
    constructor(pid, ppid, uid, euid, suid, gid, egid, sgid, cwd, umask) {
        this.pid = pid;
        this.ppid = ppid;
        this.uid = uid;
        this.euid = euid;
        this.suid = suid;
        this.gid = gid;
        this.egid = egid;
        this.sgid = sgid;
        this.cwd = cwd;
        this.umask = umask;
        this.startTime = performance.now();
    }

}

const ROOT_PROCESS = new PCB(0, 0, 0, 0, 0, 0, 0, 0, '/', 0o022);

export let current_process = ROOT_PROCESS;

/**
 *
 * @param {number} uid
 * @param {number} gid
 * @param {string} cwd
 * @returns {PCB}
 */
export function createProcess(uid, gid, cwd) {
    return new PCB(++a_pid, ROOT_PROCESS.ppid, uid, uid, uid, gid, gid, gid, cwd, 0o022);
}

export function current() {
    return current_process;
}

/**
 * @param {PCB} pcb
 */
export function setCurrent(pcb) {
    current_process = pcb;
}