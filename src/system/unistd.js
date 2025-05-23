import * as grp from "./grp.js"
import * as pwd from "./pwd.js"
import {syscall, SYSCALL_NO} from "./sys/syscall.js";

/**
 * @returns {number}
 */
export function getpid() {
    return syscall(SYSCALL_NO.__NR_getpid);
}

/**
 * @returns {number}
 */
export function getppid() {
    return syscall(SYSCALL_NO.__NR_getppid);
}

/**
 * @returns {string}
 */
export function getcwd() {
    return syscall(SYSCALL_NO.__NR_getcwd);
}

/**
 * @returns {number}
 */
export function geteuid() {
    return syscall(SYSCALL_NO.__NR_geteuid);
}

/**
 * @returns {number}
 */
export function getuid() {
    return syscall(SYSCALL_NO.__NR_getuid);
}

/**
 * @returns {number}
 */
export function getresuid() {
    return syscall(SYSCALL_NO.__NR_getresuid);
}

/**
 * @param {number} uid
 * @returns {*}
 */
export function setuid(uid) {
    return syscall(SYSCALL_NO.__NR_setuid, uid);
}

/**
 * @param {number} ruid
 * @param {number} euid
 * @returns {*}
 */
export function setreuid(ruid, euid) {
    return syscall(SYSCALL_NO.__NR_setreuid, ruid, euid);
}

/**
 * @param {number} ruid
 * @param {number} euid
 * @param {number} suid
 * @returns {*}
 */
export function setresuid(ruid, euid, suid) {
    return syscall(SYSCALL_NO.__NR_setresuid, ruid, euid, suid);
}

/**
 * @returns {number}
 */
export function getgid() {
    return syscall(SYSCALL_NO.__NR_getegid);
}

/**
 * @returns {number}
 */
export function getegid() {
    return syscall(SYSCALL_NO.__NR_getegid);
}

/**
 * @returns {number}
 */
export function getresgid() {
    return syscall(SYSCALL_NO.__NR_getresgid);
}

/**
 * @param {number} gid
 * @returns {*}
 */
export function setgid(gid) {
    return syscall(SYSCALL_NO.__NR_setgid, gid);
}

/**
 * @param {number} rgid
 * @param {number} egid
 * @returns {*}
 */
export function setregid(rgid, egid) {
    return syscall(SYSCALL_NO.__NR_setregid, rgid, egid);
}

/**
 * @param {number} rgid
 * @param {number} egid
 * @param {number} sgid
 * @returns {*}
 */
export function setresgid(rgid, egid, sgid) {
    return syscall(SYSCALL_NO.__NR_setresgid, rgid, egid, sgid);
}

/**
 * @param {number} euid
 * @returns {*}
 */
export function seteuid(euid) {
    return syscall(SYSCALL_NO.__NR_setreuid, -1, euid, -1);
}

/**
 * @param {number} egid
 * @returns {*}
 */
export function setegid(egid) {
    return syscall(SYSCALL_NO.__NR_setregid, -1, egid, -1);
}


/**
 * @param {string} path
 * @param {number} flag
 * @param {number} mode
 * @returns {number}
 */
export function open(path, flag, mode) {
    return syscall(SYSCALL_NO.__NR_open, path, flag, mode);
}

/**
 * @param {number} fd
 * @param {number} length
 * @returns {string}
 */
export function read(fd, length) {
    return syscall(SYSCALL_NO.__NR_read, fd, length);
}

/**
 * @param {number} fd
 * @param {string} data
 * @returns {number}
 */
export function write(fd, data) {
    return syscall(SYSCALL_NO.__NR_write, fd, data);
}

/**
 * @param {number} fd
 * @param {number} offset
 * @param {number} whence
 * @returns {number}
 */
export function lseek(fd, offset, whence) {
    return syscall(SYSCALL_NO.__NR_lseek, fd, offset, whence);
}

/**
 * @param {number} fd
 * @returns {boolean}
 */
export function close(fd) {
    return syscall(SYSCALL_NO.__NR_close, fd);
}

/**
 * @param {string} path
 * @param {number} mode
 * @returns {boolean}
 */
export function mkdir(path, mode) {
    return syscall(SYSCALL_NO.__NR_mkdir, path, mode);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function unlink(path) {
    return syscall(SYSCALL_NO.__NR_unlink, path);
}

/**
 *
 * @param {string} path
 * @returns {boolean}
 */
export function rmdir(path) {
    return syscall(SYSCALL_NO.__NR_rmdir, path);
}

/**
 *
 * @param {string} path
 * @returns {object}
 */
export function stat(path) {
    return syscall(SYSCALL_NO.__NR_stat, path);
}

/**
 * @param {string} path
 * @param {number} mode
 * @returns {boolean}
 */
export function chmod(path, mode) {
    return syscall(SYSCALL_NO.__NR_chmod, path, mode);
}

/**
 * @param {string} path
 * @param {number} uid
 * @param {number} gid
 * @returns {boolean}
 */
export function chown(path, uid, gid) {
    return syscall(SYSCALL_NO.__NR_chown, path, uid, gid);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function chdir(path) {
    return syscall(SYSCALL_NO.__NR_chdir, path);
}

/**
 * @param {number} uid
 * @returns {Passwd}
 */
export function getpwuid(uid) {
    return pwd.getpwuid(uid);
}


/**
 * @param {string} name
 * @returns {Passwd}
 */
export function getpwnam(name) {
    return pwd.getpwnam(name);
}

/**
 * @param {number} gid
 * @returns {Group}
 */
export function getgrgid(gid) {
    return grp.getgrgid(gid);
}

/**
 * @param {string} name
 * @returns {Group}
 */
export function getgrnam(name) {
    return grp.getgrnam(name);
}