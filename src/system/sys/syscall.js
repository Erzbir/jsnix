const MODE = Object.freeze({
    KERNEL: 0,
    USER: 1,
});

let currentMode = MODE.USER

export const SYSCALL_NO = Object.freeze({
    __NR_read: 0,
    __NR_write: 1,
    __NR_open: 2,
    __NR_close: 3,
    __NR_stat: 4,
    __NR_lseek: 19,
    __NR_getpid: 39,
    __NR_getcwd: 79,
    __NR_chdir: 80,
    __NR_mkdir: 83,
    __NR_rmdir: 84,
    __NR_unlink: 87,
    __NR_chmod: 90,
    __NR_chown: 92,
    __NR_getuid: 102,
    __NR_getgid: 104,
    __NR_setuid: 105,
    __NR_setgid: 106,
    __NR_geteuid: 107,
    __NR_getegid: 108,
    __NR_getppid: 110,
    __NR_setreuid: 113,
    __NR_setregid: 114,
    __NR_getgroups: 115,
    __NR_setgroups: 116,
    __NR_setresuid: 117,
    __NR_getresuid: 118,
    __NR_setresgid: 119,
    __NR_getresgid: 120,
});

const SYSCALL_FN_TABLE = {}

export function register_syscall(syscallNum, fn) {
    if (SYSCALL_FN_TABLE[syscallNum]) {
        return;
    }
    SYSCALL_FN_TABLE[syscallNum] = fn;
}

export function syscall(syscallNum, ...args) {
    const previousMode = currentMode;
    if (currentMode !== MODE.USER) {
        throw new Error("System calls can only be made from user mode");
    }
    if (!SYSCALL_FN_TABLE[syscallNum]) {
        throw new Error(`Invalid system call number: ${syscallNum}`);
    }
    try {
        currentMode = MODE.KERNEL;
        return SYSCALL_FN_TABLE[syscallNum](...args);
    } catch (e) {
        throw e;
    } finally {
        currentMode = previousMode;
    }
}