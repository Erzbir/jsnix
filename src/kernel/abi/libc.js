/**
 * kernel/abi/libc.js - Simulated user-space syscall wrapper ABI
 *
 * This module sits at the boundary between executable JavaScript programs and
 * the kernel syscall table. User-facing code can still import usr/lib/libc.js;
 * kernel exec code imports this ABI module so it does not depend on usr/.
 */

'use strict';

import {ksyms} from '../ksyms.js';
import {
    EBADF,
    EACCES,
    EAGAIN,
    ECHILD,
    EEXIST,
    EINVAL,
    EIO,
    EISDIR,
    ENOENT,
    ENOEXEC,
    ENOSYS,
    ENOTTY,
    ENOTDIR,
    ENOTEMPTY,
    EPIPE,
    ELOOP,
    EPERM,
    ESPIPE,
    ECHO,
    ICANON,
    ISIG,
    O_APPEND,
    O_CREAT,
    O_EXCL,
    O_RDONLY,
    O_RDWR,
    O_TRUNC,
    O_WRONLY,
    SEEK_CUR,
    SEEK_END,
    SEEK_SET,
    ESRCH,
    SIGTERM,
    TIOCGWINSZ,
    TIOCSWINSZ,
    TIOCGPGRP,
    TIOCSPGRP,
} from '../include/types.js';

// strerror(3).
const _errno_str = {
    [EPERM]: 'Operation not permitted',
    [ENOENT]: 'No such file or directory',
    [ESRCH]: 'No such process',
    [EIO]: 'Input/output error',
    [EBADF]: 'Bad file descriptor',
    [ENOEXEC]: 'Exec format error',
    [EACCES]: 'Permission denied',
    [EAGAIN]: 'Resource temporarily unavailable',
    [ECHILD]: 'No child processes',
    [EEXIST]: 'File exists',
    [ENOTDIR]: 'Not a directory',
    [EISDIR]: 'Is a directory',
    [EINVAL]: 'Invalid argument',
    [ENOTTY]: 'Inappropriate ioctl for device',
    [ESPIPE]: 'Illegal seek',
    [EPIPE]: 'Broken pipe',
    [ENOSYS]: 'Function not implemented',
    [ENOTEMPTY]: 'Directory not empty',
    [ELOOP]: 'Too many levels of symbolic links',
};

export function strerror(n) {
    return _errno_str[n] ?? `Unknown error ${n}`;
}

// Parse /etc/passwd entries.
// Analogous to glibc nss/nss_files/files-pwd.c.
function _parse_passwd(line) {
    // Format: name:x:uid:gid:gecos:home:shell.
    const f = line.split(':');
    if (f.length < 7) return null;
    return {
        name     : f[0],
        uid      : Number(f[2]),
        gid      : Number(f[3]),
        gecos    : f[4],
        home     : f[5],
        shell    : f[6],
        pw_name  : f[0],
        pw_uid   : Number(f[2]),
        pw_gid   : Number(f[3]),
        pw_gecos : f[4],
        pw_dir   : f[5],
        pw_shell : f[6],
    };
}

// Read /etc/passwd through the system call interface.
function _read_passwd(pid) {
    const ret = ksyms.syscall(pid, ksyms.nr.__NR_readfile, '/etc/passwd');
    if (ret.err) return [];
    return ret.val
        .split('\n')
        .map(_parse_passwd)
        .filter(Boolean);
}

// Create a libc interface bound to one process ID.
export function make_libc(pid) {

    function __sc(nr, ...args) {
        const ret = ksyms.syscall(pid, nr, ...args);
        if (ret.err !== undefined) {
            const e = new Error(strerror(-ret.err));
            e.errno = -ret.err;
            e.nr = nr;
            throw e;
        }
        return ret.val;
    }

    const nr = ksyms.nr;

    return Object.freeze({
        // File input and output.
        read: path => __sc(nr.__NR_readfile, path),
        write: (path, d, ap) => __sc(nr.__NR_writefile, path, d, ap ?? false),
        stat: path => __sc(nr.__NR_stat, path),
        lstat: path => __sc(nr.__NR_lstat, path),
        link: (source, destination) =>
            __sc(nr.__NR_link, source, destination),
        symlink: (target, linkpath) =>
            __sc(nr.__NR_symlink, target, linkpath),
        readlink: path => __sc(nr.__NR_readlink, path),
        canonicalize: path => __sc(nr.__NR_realpath, path),
        mkdir: (path, mode) => __sc(nr.__NR_mkdir, path, mode ?? 0o777),
        unlink: path => __sc(nr.__NR_unlink, path),
        rmdir: path => __sc(nr.__NR_rmdir, path),
        rename: (s, d) => __sc(nr.__NR_rename, s, d),
        readdir: path => __sc(nr.__NR_getdents, path),
        chdir: path => __sc(nr.__NR_chdir, path),
        getcwd: () => __sc(nr.__NR_getcwd),
        chmod: (path, mode) => __sc(nr.__NR_chmod, path, mode),
        chown: (path, u, g) => __sc(nr.__NR_chown, path, u, g),
        truncate: (path, len) => __sc(nr.__NR_truncate, path, len ?? 0),
        access: (path, mode) => __sc(nr.__NR_access, path, mode ?? 0),
        open: (path, flags, mode) =>
            __sc(nr.__NR_open, path, flags ?? O_RDONLY, mode ?? 0o666),
        close: fd => __sc(nr.__NR_close, fd),
        readfd: (fd, count) => __sc(nr.__NR_read, fd, count),
        writefd: (fd, data) => __sc(nr.__NR_write, fd, data),
        lseek: (fd, offset, whence) =>
            __sc(nr.__NR_lseek, fd, offset, whence ?? SEEK_SET),
        dup: fd => __sc(nr.__NR_dup, fd),
        dup2: (oldfd, newfd) => __sc(nr.__NR_dup2, oldfd, newfd),
        pipe: () => __sc(nr.__NR_pipe),
        isatty: fd => __sc(nr.__NR_isatty, fd),
        tcgetattr: fd => __sc(nr.__NR_tcgetattr, fd),
        tcsetattr: (fd, termios) => __sc(nr.__NR_tcsetattr, fd, termios),
        ioctl: (fd, request, value) =>
            __sc(nr.__NR_ioctl, fd, request, value),

        // Process management.
        getpid: () => __sc(nr.__NR_getpid),
        getppid: () => __sc(nr.__NR_getppid),
        getuid: () => __sc(nr.__NR_getuid),
        getgid: () => __sc(nr.__NR_getgid),
        geteuid: () => __sc(nr.__NR_geteuid),
        getegid: () => __sc(nr.__NR_getegid),
        getgroups: () => __sc(nr.__NR_getgroups),
        setuid: uid => __sc(nr.__NR_setuid, uid),
        setgid: gid => __sc(nr.__NR_setgid, gid),
        setgroups: groups => __sc(nr.__NR_setgroups, groups),
        getlogin: () => __sc(nr.__NR_getlogin),
        umask: mode => __sc(nr.__NR_umask, mode),
        kill: (p, sig) => __sc(nr.__NR_kill, p, sig ?? SIGTERM),
        _exit: code => __sc(nr.__NR_exit, code ?? 0),
        wait4: (pid, options) =>
            __sc(nr.__NR_wait4, pid ?? -1, options ?? 0),
        getpgid: pid => __sc(nr.__NR_getpgid, pid ?? 0),
        setpgid: (pid, pgid) =>
            __sc(nr.__NR_setpgid, pid ?? 0, pgid ?? 0),
        getsid: pid => __sc(nr.__NR_getsid, pid ?? 0),
        setsid: () => __sc(nr.__NR_setsid),

        // User and group management.
        getpwnam(name) {
            return _read_passwd(pid).find(e => e.pw_name === name) ?? null;
        },
        getpwuid(uid) {
            return _read_passwd(pid).find(e => e.pw_uid === uid) ?? null;
        },
        getusers() {
            return _read_passwd(pid).map(e => e.pw_name);
        },
        useradd: (name, options) =>
            __sc(nr.__NR_useradd, name, options ?? {}),
        userdel: name => __sc(nr.__NR_userdel, name),
        usermod: (name, options) =>
            __sc(nr.__NR_usermod, name, options ?? {}),
        groupadd: (name, gid) => __sc(nr.__NR_groupadd, name, gid),
        groupdel: name => __sc(nr.__NR_groupdel, name),
        groupmod: (name, options) =>
            __sc(nr.__NR_groupmod, name, options ?? {}),
        groupmem: (group, name, add) =>
            __sc(nr.__NR_groupmem, group, name, add),
        passwd: (name, pw) => __sc(nr.__NR_passwd, name, pw),
        su: (name, pw) => __sc(nr.__NR_su, name, pw),
        getgrnam: name => __sc(nr.__NR_getgrnam, name),
        getgrgid: gid => __sc(nr.__NR_getgrgid, gid),

        // Environment variables.
        getenv: k => __sc(nr.__NR_getenv, k),
        setenv: (k, v) => __sc(nr.__NR_setenv, k, v),
        unsetenv: k => __sc(nr.__NR_unsetenv, k),

        // System information.
        uname: () => __sc(nr.__NR_uname),
        time: () => __sc(nr.__NR_time),
        sysinfo: () => __sc(nr.__NR_sysinfo),
        syslog: message => __sc(nr.__NR_syslog, message),
        reboot: action => __sc(nr.__NR_reboot, action ?? 'restart'),

        // Path helper.
        realpath(path) {
            const snap = ksyms.get_task(pid);
            const cwd = snap?.cwd ?? '/';
            let absolute = String(path ?? '');
            if (!absolute.startsWith('/'))
                absolute = `${cwd.replace(/\/+$/, '') || '/'}${cwd === '/' ? '' : '/'}${absolute}`;
            if (absolute === '/' || absolute.endsWith('/.') || absolute.endsWith('/..')) {
                try {
                    return __sc(nr.__NR_realpath, absolute);
                } catch {
                    return ksyms.path_resolve(absolute, '/');
                }
            }

            const trimmed = absolute.replace(/\/+$/, '');
            const slash = trimmed.lastIndexOf('/');
            const parent = trimmed.slice(0, slash) || '/';
            const basename = trimmed.slice(slash + 1);
            try {
                const canonical_parent = __sc(nr.__NR_realpath, parent);
                return `${canonical_parent === '/' ? '' : canonical_parent}/${basename}`;
            } catch {
                return ksyms.path_resolve(absolute, '/');
            }
        },

        strerror,
        constants: Object.freeze({
            O_RDONLY,
            O_WRONLY,
            O_RDWR,
            O_CREAT,
            O_EXCL,
            O_TRUNC,
            O_APPEND,
            SEEK_SET,
            SEEK_CUR,
            SEEK_END,
            ISIG,
            ICANON,
            ECHO,
            TIOCGWINSZ,
            TIOCSWINSZ,
            TIOCGPGRP,
            TIOCSPGRP,
        }),
    });
}
