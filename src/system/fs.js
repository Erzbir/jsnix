import {syscall, SYSCALL_NO} from "./sys/syscall.js";

export const OP_FLAG = Object.freeze({
    O_RDONLY: 0x0000,
    O_WRONLY: 0x0001,
    O_RDWR: 0x0002,
    O_CREAT: 0x0040,
    O_EXCL: 0x0080,
    O_NOCTTY: 0x0100,
    O_TRUNC: 0x0200,
    O_APPEND: 0x0400,
});

export const FILE_TYPE = Object.freeze({
    DIR: 'd',
    FILE: 'f',
});

/**
 * @param {string} path
 * @param {number} mode
 * @returns {number}
 */
export function createFile(path, mode = 0o644) {
    const fd = open(path, OP_FLAG.O_CREAT, mode);
    close(fd);
    return fd;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function rm(path) {
    const file = stat(path);
    if (file.type === FILE_TYPE.DIR) {
        return rmdir(path)
    } else {
        return unlink(path);
    }
}

/**
 * @param {string} path
 * @returns {string}
 */
export function readFile(path) {
    const fd = open(path, OP_FLAG.O_RDONLY);
    const content = read(fd);
    close(fd);
    return content;
}

/**
 * @param {string} path
 * @param {string} data
 * @param {number} mode
 * @returns {number}
 */
export function writeFile(path, data, mode = 0o644) {
    const fd = open(path, OP_FLAG.O_RDWR | OP_FLAG.O_CREAT, mode);
    const content = write(fd, data);
    close(fd);
    return content;
}

/**
 * @param {string} path
 * @param {string} data
 * @returns {number}
 */
export function appendFile(path, data) {
    const fd = open(path, OP_FLAG.O_RDWR | OP_FLAG.O_APPEND | OP_FLAG.O_CREAT);
    const content = write(fd, data);
    close(fd);
    return content;
}

/**
 *
 * @param {string} path
 * @param {number} flag
 * @param {number} mode
 * @returns {number}
 */
export function open(path, flag, mode = 0o644) {
    return syscall(SYSCALL_NO.__NR_open, path, flag, mode);
}

/**
 *
 * @param {number} fd
 * @param {number} offset
 * @param {number} whence
 * @returns {number}
 */
export function lseek(fd, offset, whence) {
    return syscall(SYSCALL_NO.__NR_lseek, fd, offset, length);
}

/**
 *
 * @param {number} fd
 * @param {number} length
 * @returns {string}
 */
export function read(fd, length = undefined) {
    return syscall(SYSCALL_NO.__NR_read, fd, length);
}

/**
 *
 * @param {number} fd
 * @param {string} data
 * @returns {number}
 */
export function write(fd, data) {
    return syscall(SYSCALL_NO.__NR_write, fd, data);
}

/**
 *
 * @param {number} fd
 * @returns {boolean}
 */
export function close(fd) {
    return syscall(SYSCALL_NO.__NR_close, fd);
}

/**
 *
 * @param {string} path
 * @param {number} mode
 * @returns {boolean}
 */
export function mkdir(path, mode = 0o755) {
    return syscall(SYSCALL_NO.__NR_mkdir, path, mode);
}

/**
 *
 * @param {string} path
 * @returns {boolean}
 */
export function unlink(path) {
    return syscall(SYSCALL_NO.__NR_unlink, path);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function rmdir(path) {
    return syscall(SYSCALL_NO.__NR_rmdir, path);
}

/**
 *
 * @param {string} path
 * @returns {{}}
 */
export function stat(path) {
    return syscall(SYSCALL_NO.__NR_stat, path);
}
