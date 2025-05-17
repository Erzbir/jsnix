import * as fs from "./fs.js"
import * as grp from "./grp.js"
import * as pwd from "./pwd.js"
import {syscall, SYSCALL_NO} from "./sys/syscall.js";

export function getpid() {
    return syscall(SYSCALL_NO.__NR_getpid);
}

export function getppid() {
    return syscall(SYSCALL_NO.__NR_getppid);
}

export function getcwd() {
    return syscall(SYSCALL_NO.__NR_getcwd);
}

export function geteuid() {
    return syscall(SYSCALL_NO.__NR_geteuid);
}

export function getuid() {
    return syscall(SYSCALL_NO.__NR_getuid);
}

export function getresuid() {
    return syscall(SYSCALL_NO.__NR_getresuid);
}

export function setuid(uid) {
    return syscall(SYSCALL_NO.__NR_setuid, uid);
}

export function setreuid(ruid, euid) {
    return syscall(SYSCALL_NO.__NR_setreuid, ruid, euid);
}

export function setresuid(ruid, euid, suid) {
    return syscall(SYSCALL_NO.__NR_setresuid, ruid, euid, suid);
}

export function getgid() {
    return syscall(SYSCALL_NO.__NR_getegid);
}

export function getegid() {
    return syscall(SYSCALL_NO.__NR_getegid);
}

export function getresgid() {
    return syscall(SYSCALL_NO.__NR_getresgid);
}

export function setgid(gid) {
    return syscall(SYSCALL_NO.__NR_setgid, gid);
}

export function setregid(rgid, egid) {
    return syscall(SYSCALL_NO.__NR_setregid, rgid, egid);
}

export function setresgid(rgid, egid, sgid) {
    return syscall(SYSCALL_NO.__NR_setresgid, rgid, egid, sgid);
}

export function seteuid(euid) {
    return syscall(SYSCALL_NO.__NR_setreuid, -1, euid, -1);
}

export function setegid(egid) {
    return syscall(SYSCALL_NO.__NR_setregid, -1, egid, -1);
}


export function open(path, flag, mode) {
    return fs.open(path, flag, mode);
}

export function read(fd, length) {
    return fs.read(fd, length);
}

export function write(fd, data) {
    return fs.write(fd, data);
}

export function lseek(fd, offset, whence) {
    return fs.lseek(fd, offset, whence);
}

export function close(fd) {
    return fs.close(fd);
}

export function mkdir(path, mode) {
    return fs.mkdir(path, mode);
}

export function unlink(path) {
    return fs.unlink(path);
}

export function rmdir(path) {
    return fs.rmdir(path);
}

export function stat(path) {
    return fs.stat(path);
}

export function chmod(path, mode) {
    return syscall(SYSCALL_NO.__NR_chmod, path, mode);
}

export function chown(path, uid, gid) {
    return syscall(SYSCALL_NO.__NR_chown, path, uid, gid);
}

export function chdir(path) {
    return syscall(SYSCALL_NO.__NR_chdir, path);
}

export function getpwuid(uid) {
    return pwd.getpwuid(uid);
}


export function getpwnam(name) {
    return pwd.getpwnam(name);
}

export function getgrgid(gid) {
    return grp.getgrgid(gid);
}

export function getgrnam(name) {
    return grp.getgrnam(name);
}