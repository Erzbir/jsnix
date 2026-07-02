/**
 * kernel/syscall/dispatcher.js - System call dispatch
 *
 * Analogous to:
 *   kernel/sys.c            - generic syscall implementations
 *   arch/x86/kernel/entry.S - syscall entry (entry_SYSCALL_64)
 *   kernel/printk/printk.c  - printk()
 *   init/main.c             - kernel_init()
 */

'use strict';

import * as NR from '../include/syscall_nr.js';
import {
    EBADF,
    AT_EACCESS,
    AT_FDCWD,
    EACCES,
    EEXIST,
    EIO,
    EINVAL,
    EISDIR,
    ENOENT,
    ENOSYS,
    ENOTTY,
    ENOTDIR,
    EPIPE,
    EPERM,
    ESRCH,
    ESPIPE,
    MAY_EXEC,
    MAY_READ,
    MAY_WRITE,
    O_ACCMODE,
    O_APPEND,
    O_CREAT,
    O_EXCL,
    O_RDONLY,
    O_RDWR,
    O_TRUNC,
    O_WRONLY,
    RING_ROOT,
    RING_USER,
    ROOT_GID,
    ROOT_UID,
    S_ISGID,
    S_ISUID,
    SEEK_CUR,
    SEEK_END,
    SEEK_SET,
    SIGTERM,
    TASK_ZOMBIE,
    TIOCGWINSZ,
    TIOCSWINSZ,
    TIOCGPGRP,
    TIOCSPGRP,
} from '../include/types.js';
import {
    inode_permission,
    path_from_cwd,
    path_lookup,
    path_lookup_user,
    path_lstat_user,
    path_realpath_user,
    path_parent_user,
    proc_update,
    vfs_chmod,
    vfs_chown,
    vfs_create,
    vfs_link,
    vfs_mkdir,
    vfs_read,
    vfs_readlink,
    vfs_readdir,
    vfs_rename,
    vfs_rmdir,
    vfs_stat,
    vfs_symlink,
    vfs_unlink,
    vfs_write,
} from '../fs/vfs.js';
import {
    close_task_fd,
    file_get,
} from '../fs/file.js';
import {
    byte_length,
    replace_text_bytes,
    resize_text_bytes,
    slice_text_bytes,
} from '../fs/bytes.js';
import {
    authenticate,
    getgrgid,
    getgrnam,
    getpwnam,
    getpwuid,
    sys_group_member,
    sys_groupadd,
    sys_groupdel,
    sys_groupmod,
    sys_passwd,
    sys_useradd,
    sys_userdel,
    sys_usermod,
    uid_to_username,
} from '../security/credentials.js';
import {
    do_setgid,
    do_setgroups,
    do_setuid,
} from '../cred.js';
import {do_exit} from '../exit.js';
import {do_wait4} from '../wait.js';
import {do_fork} from '../fork.js';
import {task_table} from '../sched/core.js';
import {send_signal} from '../signal.js';
import {kernel_power_request} from '../power.js';
import {
    do_getpgid,
    do_getsid,
    do_setpgid,
    do_setsid,
} from '../process/group.js';
import {
    clone_termios,
    clone_winsize,
    is_tty_device_name,
    is_tty_path,
    normalize_termios,
    normalize_winsize,
} from '../tty/termios.js';

export let kernel_boot_time = Date.now();

function read_kernel_config(path, fallback = '') {
    const inode = path_lookup(path);
    if (inode?.i_type !== 'file') return fallback;
    const value = String(inode.i_data ?? '').trim();
    return value || fallback;
}

export function reset_kernel_clock() {
    kernel_boot_time = Date.now();
}

export function printk(msg) {
    const secs = ((Date.now() - kernel_boot_time) / 1000).toFixed(6);
    const inode = path_lookup('/var/log/kern.log');
    if (inode) inode.i_data += `[${secs}] ${msg}\n`;
}

function normalize_open_flags(flags = O_RDONLY) {
    if (typeof flags === 'number') return flags;
    const value = String(flags ?? 'r');
    return {
        r: O_RDONLY,
        'r+': O_RDWR,
        w: O_WRONLY | O_CREAT | O_TRUNC,
        'w+': O_RDWR | O_CREAT | O_TRUNC,
        a: O_WRONLY | O_CREAT | O_APPEND,
        'a+': O_RDWR | O_CREAT | O_APPEND,
    }[value] ?? O_RDONLY;
}

function fd_access(flags) {
    return normalize_open_flags(flags) & O_ACCMODE;
}

function fd_readable(flags) {
    return fd_access(flags) !== O_WRONLY;
}

function fd_writable(flags) {
    const mode = fd_access(flags);
    return mode === O_WRONLY || mode === O_RDWR;
}

function alloc_fd(task, entry, minimum = 0) {
    for (let fd = minimum; fd < 1024; fd++) {
        if (!Object.hasOwn(task.fdt, fd)) {
            task.fdt[fd] = entry;
            return fd;
        }
    }
    return -1;
}

function get_fd(task, fd) {
    if (!Number.isInteger(fd) || fd < 0) return null;
    return task.fdt?.[fd] ?? null;
}

function write_line_buffer(buffer, data) {
    if (!Array.isArray(buffer)) return;
    const text = String(data ?? '');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines)
        buffer.push({text: line, tone: 'normal'});
}

function tty_state_for(task, entry) {
    return entry?.tty ?? task.tty;
}

function is_fd_tty(task, entry) {
    if (!entry) return false;
    if (entry.kind === 'tty') return true;
    if (entry.tty && is_tty_path(entry.path)) return true;
    const device = entry.inode?.i_device;
    return entry.inode?.i_type === 'char' && is_tty_device_name(device);
}

function create_fd_entry(task, path, inode, flags) {
    const normalized = normalize_open_flags(flags);
    const entry = {
        path,
        inode,
        flags: normalized,
        readable: fd_readable(normalized),
        writable: fd_writable(normalized),
        append: Boolean(normalized & O_APPEND),
        refcount: 1,
        offset: Boolean(normalized & O_APPEND) &&
            (inode.i_type === 'file' || inode.i_type === 'link')
            ? byte_length(inode.i_data)
            : 0,
    };
    if (inode.i_type === 'char') {
        entry.kind = is_tty_device_name(inode.i_device) ? 'tty' : 'char';
        entry.device = inode.i_device;
        if (entry.kind === 'tty') entry.tty = task.tty;
    } else {
        entry.kind = 'file';
    }
    return entry;
}

function open_fd(task, raw_path, raw_flags, mode = 0o666) {
    const flags = normalize_open_flags(raw_flags);
    const abs = path_from_cwd(raw_path, task.cwd);
    const effective_uid = task.euid;
    const effective_gid = task.egid;
    let found = path_lookup_user(
        abs, effective_uid, effective_gid, task.groups);
    let inode = found.val;

    if (found.err === -ENOENT && (flags & O_CREAT)) {
        const parent = path_parent_user(
            abs, effective_uid, effective_gid, task.groups);
        if (parent.err) return parent;
        const made = vfs_create(
            parent.val[0],
            parent.val[1],
            (mode ?? 0o666) & ~task.umask,
            effective_uid,
            effective_gid,
            '',
            task.groups,
        );
        if (made.err) return made;
        inode = parent.val[0].i_data[parent.val[1]];
    } else if (found.err) {
        return found;
    } else if ((flags & O_CREAT) && (flags & O_EXCL)) {
        return {err: -EEXIST};
    }

    if (inode.i_type === 'dir' && fd_writable(flags)) return {err: -EISDIR};
    if (fd_readable(flags) &&
        inode_permission(
            inode, effective_uid, effective_gid,
            MAY_READ, task.groups) < 0)
        return {err: -EACCES};
    if (fd_writable(flags) &&
        inode_permission(
            inode, effective_uid, effective_gid,
            MAY_WRITE, task.groups) < 0)
        return {err: -EACCES};
    if ((flags & O_TRUNC) && fd_writable(flags)) {
        if (inode.i_type === 'dir') return {err: -EISDIR};
        if (inode.i_type === 'file') {
            const truncated = vfs_write(
                inode, effective_uid, effective_gid, '', false, task.groups);
            if (truncated.err) return truncated;
        }
    }

    const fd = alloc_fd(task, create_fd_entry(task, abs, inode, flags));
    return fd < 0 ? {err: -EBADF} : {val: fd};
}

function read_char_device(entry, count) {
    const length = Math.max(0, Number(count ?? 1) || 0);
    if (entry.device === 'null' || entry.device === 'full') return '';
    if (entry.device === 'zero') return '\0'.repeat(length || 1);
    if (entry.device === 'random' || entry.device === 'urandom') {
        const bytes = new Uint8Array(length || 32);
        const crypto = globalThis.crypto;
        if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
        else {
            for (let index = 0; index < bytes.length; index++)
                bytes[index] = Math.floor(Math.random() * 256);
        }
        return String.fromCharCode(...bytes);
    }
    return '';
}

function fd_read(task, fd, count = null) {
    const entry = get_fd(task, fd);
    if (!entry || !entry.readable) return {err: -EBADF};
    const limit = count === null || count === undefined
        ? Infinity
        : Math.max(0, Number(count) || 0);

    if (entry.kind === 'pipe') {
        const size = byte_length(entry.pipe.buffer);
        const amount = Number.isFinite(limit) ? limit : size;
        const value = slice_text_bytes(entry.pipe.buffer, 0, amount);
        entry.pipe.buffer = slice_text_bytes(
            entry.pipe.buffer, value.length).text;
        return {val: value.text};
    }
    if (entry.kind === 'stdio' || entry.kind === 'tty') {
        const source = String(entry.input ?? '');
        const size = byte_length(source);
        const amount = Number.isFinite(limit) ? limit : size - entry.offset;
        const value = slice_text_bytes(
            source, entry.offset, entry.offset + amount);
        entry.offset += value.length;
        return {val: value.text};
    }
    if (entry.kind === 'char')
        return {val: read_char_device(entry, limit)};
    if (entry.inode.i_type !== 'file') return {err: -EISDIR};

    const inode_data = typeof entry.inode.i_data === 'function'
        ? entry.inode.i_data()
        : entry.inode.i_data;
    const data = String(inode_data ?? '');
    const size = byte_length(data);
    const amount = Number.isFinite(limit) ? limit : size - entry.offset;
    const value = slice_text_bytes(
        data, entry.offset, entry.offset + amount);
    entry.offset += value.length;
    entry.inode.i_atime = Date.now();
    return {val: value.text};
}

function fd_write(task, fd, data) {
    const entry = get_fd(task, fd);
    if (!entry || !entry.writable) return {err: -EBADF};
    const text = String(data ?? '');

    if (entry.kind === 'pipe') {
        if ((entry.pipe.readers ?? 0) === 0) return {err: -EPIPE};
        entry.pipe.buffer += text;
        return {val: byte_length(text)};
    }
    if (entry.kind === 'stdio' || entry.kind === 'tty') {
        write_line_buffer(entry.output, text);
        return {val: byte_length(text)};
    }
    if (entry.kind === 'char') {
        if (entry.device === 'full') return {err: -EIO};
        return {val: byte_length(text)};
    }
    if (entry.inode.i_type !== 'file') return {err: -EISDIR};

    const current = String(entry.inode.i_data ?? '');
    const offset = entry.append ? byte_length(current) : entry.offset;
    const replaced = replace_text_bytes(current, offset, text);
    entry.inode.i_data = replaced.text;
    entry.inode.i_mode &= ~(S_ISUID | S_ISGID);
    entry.offset = offset + replaced.written;
    entry.inode.i_size = replaced.size;
    entry.inode.i_mtime = entry.inode.i_ctime = Date.now();
    return {val: replaced.written};
}

function fd_lseek(task, fd, offset, whence = SEEK_SET) {
    const entry = get_fd(task, fd);
    if (!entry) return {err: -EBADF};
    if (entry.kind === 'pipe' || entry.kind === 'tty' || entry.kind === 'char')
        return {err: -ESPIPE};
    const size = entry.kind === 'stdio'
        ? String(entry.input ?? '').length
        : byte_length(typeof entry.inode?.i_data === 'function'
            ? entry.inode.i_data()
            : entry.inode?.i_data);
    let next;
    if (whence === SEEK_SET) next = Number(offset);
    else if (whence === SEEK_CUR) next = entry.offset + Number(offset);
    else if (whence === SEEK_END) next = size + Number(offset);
    else return {err: -EINVAL};
    if (!Number.isFinite(next) || next < 0) return {err: -EINVAL};
    entry.offset = Math.floor(next);
    return {val: entry.offset};
}

function fd_close(task, fd) {
    const entry = get_fd(task, fd);
    if (!entry) return {err: -EBADF};
    close_task_fd(task, fd);
    return {val: 0};
}

function fd_dup(task, oldfd, requested = null) {
    const entry = get_fd(task, oldfd);
    if (!entry) return {err: -EBADF};
    if (requested !== null && requested !== undefined) {
        if (!Number.isInteger(requested) || requested < 0) return {err: -EBADF};
        if (requested === oldfd) return {val: requested};
        if (get_fd(task, requested)) fd_close(task, requested);
        task.fdt[requested] = file_get(entry);
        return {val: requested};
    }
    const fd = alloc_fd(task, file_get(entry));
    return fd < 0 ? {err: -EBADF} : {val: fd};
}

function fd_pipe(task) {
    const pipe = {buffer: '', readers: 1, writers: 1};
    const readfd = alloc_fd(task, {
        path: 'pipe:[read]',
        flags: 'r',
        kind: 'pipe',
        readable: true,
        writable: false,
        offset: 0,
        pipe,
        refcount: 1,
    });
    if (readfd < 0) return {err: -EBADF};
    const writefd = alloc_fd(task, {
        path: 'pipe:[write]',
        flags: 'w',
        kind: 'pipe',
        readable: false,
        writable: true,
        offset: 0,
        pipe,
        refcount: 1,
    });
    if (writefd < 0) {
        close_task_fd(task, readfd);
        return {err: -EBADF};
    }
    return {val: [readfd, writefd]};
}

function tcgetattr(task, fd) {
    const entry = get_fd(task, fd);
    if (!entry) return {err: -EBADF};
    if (!is_fd_tty(task, entry)) return {err: -ENOTTY};
    return {val: clone_termios(tty_state_for(task, entry).termios)};
}

function tcsetattr(task, fd, termios) {
    const entry = get_fd(task, fd);
    if (!entry) return {err: -EBADF};
    if (!is_fd_tty(task, entry)) return {err: -ENOTTY};
    tty_state_for(task, entry).termios = normalize_termios(termios);
    return {val: 0};
}

function fd_ioctl(task, fd, request, value) {
    const entry = get_fd(task, fd);
    if (!entry) return {err: -EBADF};
    if (!is_fd_tty(task, entry)) return {err: -ENOTTY};
    const tty = tty_state_for(task, entry);
    if (request === TIOCGWINSZ) return {val: clone_winsize(tty.winsize)};
    if (request === TIOCSWINSZ) {
        tty.winsize = normalize_winsize(value);
        return {val: 0};
    }
    if (request === TIOCGPGRP) return {val: tty.foreground_pgid};
    if (request === TIOCSPGRP) {
        if (!Number.isInteger(value) || value <= 0) return {err: -EINVAL};
        const group = [...task_table.values()].find(candidate =>
            candidate.pgid === value && candidate.sid === task.sid);
        if (!group) return {err: -EPERM};
        tty.foreground_pgid = value;
        return {val: 0};
    }
    return {err: -EINVAL};
}

function user_lookup(ctx, path) {
    return path_lookup_user(
        path_from_cwd(path, ctx.task.cwd),
        ctx.effective_uid,
        ctx.effective_gid,
        ctx.task.groups,
    );
}

function user_lstat(ctx, path) {
    return path_lstat_user(
        path_from_cwd(path, ctx.task.cwd),
        ctx.effective_uid,
        ctx.effective_gid,
        ctx.task.groups,
    );
}

function user_parent(ctx, path) {
    return path_parent_user(
        path_from_cwd(path, ctx.task.cwd),
        ctx.effective_uid,
        ctx.effective_gid,
        ctx.task.groups,
    );
}

const syscall_handlers = new Map();

function syscall_needs_proc_refresh(task, args) {
    return args.some(value => {
        if (typeof value !== 'string') return false;
        const path = path_from_cwd(value, task.cwd);
        return path === '/proc' || path.startsWith('/proc/') ||
            path === '/etc/mtab' ||
            path === '/dev/fd' || path.startsWith('/dev/fd/') ||
            ['/dev/stdin', '/dev/stdout', '/dev/stderr'].includes(path);
    });
}

function register_syscall(number, handler) {
    syscall_handlers.set(number, handler);
}

function register_syscalls(entries) {
    for (const [number, handler] of entries)
        register_syscall(number, handler);
}

register_syscalls([
    [NR.__NR_readfile, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        if (found.err) return found;
        return vfs_read(
            found.val, ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
    }],
    [NR.__NR_writefile, (ctx, args) => {
        const abs = path_from_cwd(args[0], ctx.task.cwd);
        const found = path_lookup_user(
            abs, ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
        if (!found.err)
            return vfs_write(
                found.val, ctx.effective_uid, ctx.effective_gid,
                args[1], args[2], ctx.task.groups);
        if (found.err !== -ENOENT) return found;
        const parent = path_parent_user(
            abs, ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
        if (parent.err) return parent;
        return vfs_create(
            parent.val[0], parent.val[1], 0o666 & ~ctx.task.umask,
            ctx.effective_uid, ctx.effective_gid, args[1] ?? '',
            ctx.task.groups);
    }],
    [NR.__NR_stat, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        return found.err ? found : {val: vfs_stat(found.val)};
    }],
    [NR.__NR_mkdir, (ctx, args) => {
        const result = user_parent(ctx, args[0]);
        if (result.err) return result;
        const [parent, name] = result.val;
        return vfs_mkdir(
            parent, name, (args[1] ?? 0o777) & ~ctx.task.umask,
            ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
    }],
    [NR.__NR_unlink, (ctx, args) => {
        const result = user_parent(ctx, args[0]);
        if (result.err) return result;
        const [parent, name] = result.val;
        return vfs_unlink(
            parent, name, ctx.effective_uid, ctx.effective_gid,
            ctx.task.groups);
    }],
    [NR.__NR_rmdir, (ctx, args) => {
        const result = user_parent(ctx, args[0]);
        if (result.err) return result;
        const [parent, name] = result.val;
        return vfs_rmdir(
            parent, name, ctx.effective_uid, ctx.effective_gid,
            ctx.task.groups);
    }],
    [NR.__NR_rename, (ctx, args) => {
        const src = user_parent(ctx, args[0]);
        const dst = user_parent(ctx, args[1]);
        if (src.err) return src;
        if (dst.err) return dst;
        const [sp, sn] = src.val;
        const [dp, dn] = dst.val;
        return vfs_rename(
            sp, sn, dp, dn, ctx.effective_uid, ctx.effective_gid,
            ctx.task.groups);
    }],
    [NR.__NR_getdents, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        if (found.err) return found;
        return vfs_readdir(
            found.val, ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
    }],
    [NR.__NR_chdir, (ctx, args) => {
        const abs = path_from_cwd(args[0], ctx.task.cwd);
        const found = path_lookup_user(
            abs, ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
        if (found.err) return found;
        const inode = found.val;
        if (inode.i_type !== 'dir') return {err: -ENOTDIR};
        if (inode_permission(
            inode, ctx.effective_uid, ctx.effective_gid,
            MAY_EXEC, ctx.task.groups) < 0)
            return {err: -EACCES};
        ctx.task.cwd = ctx.task.envp.PWD = found.path;
        return {val: found.path};
    }],
    [NR.__NR_getcwd, ctx => ({val: ctx.task.cwd})],
    [NR.__NR_chmod, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        return found.err
            ? found
            : vfs_chmod(
                found.val,
                args[1],
                ctx.effective_uid,
                ctx.task.groups,
            );
    }],
    [NR.__NR_chown, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        return found.err
            ? found
            : vfs_chown(
                found.val, args[1], args[2], ctx.effective_uid,
                ctx.task.groups);
    }],
    [NR.__NR_truncate, (ctx, args) => {
        const found = user_lookup(ctx, args[0]);
        if (found.err) return found;
        const inode = found.val;
        if (inode.i_type !== 'file') return {err: -EISDIR};
        if (inode_permission(
            inode, ctx.effective_uid, ctx.effective_gid,
            MAY_WRITE, ctx.task.groups) < 0)
            return {err: -EACCES};
        const length = Number(args[1] ?? 0);
        if (!Number.isSafeInteger(length) || length < 0)
            return {err: -EINVAL};
        inode.i_data = resize_text_bytes(inode.i_data ?? '', length);
        inode.i_size = byte_length(inode.i_data);
        inode.i_mode &= ~(S_ISUID | S_ISGID);
        inode.i_mtime = inode.i_ctime = Date.now();
        return {val: 0};
    }],
    [NR.__NR_access, (ctx, args) => {
        const found = path_lookup_user(
            path_from_cwd(args[0], ctx.task.cwd),
            ctx.task.uid, ctx.task.gid, ctx.task.groups);
        if (found.err) return found;
        const mask = args[1] ?? 0;
        if (mask && inode_permission(
            found.val, ctx.task.uid, ctx.task.gid, mask,
            ctx.task.groups) < 0)
            return {err: -EACCES};
        return {val: 0};
    }],
    [NR.__NR_faccessat2, (ctx, args) => {
        const [dirfd, path, mask = 0, flags = 0] = args;
        if (dirfd !== AT_FDCWD) return {err: -EBADF};
        if (flags & ~AT_EACCESS) return {err: -EINVAL};
        const effective = Boolean(flags & AT_EACCESS);
        const uid = effective ? ctx.task.euid : ctx.task.uid;
        const gid = effective ? ctx.task.egid : ctx.task.gid;
        const found = path_lookup_user(
            path_from_cwd(path, ctx.task.cwd),
            uid,
            gid,
            ctx.task.groups,
        );
        if (found.err) return found;
        if (mask && inode_permission(
            found.val, uid, gid, mask, ctx.task.groups) < 0)
            return {err: -EACCES};
        return {val: 0};
    }],
    [NR.__NR_lstat, (ctx, args) => {
        const found = user_lstat(ctx, args[0]);
        return found.err ? found : {val: vfs_stat(found.val)};
    }],
    [NR.__NR_link, (ctx, args) => {
        const source = user_lstat(ctx, args[0]);
        if (source.err) return source;
        const destination = user_parent(ctx, args[1]);
        if (destination.err) return destination;
        return vfs_link(
            destination.val[0], destination.val[1], source.val,
            ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
    }],
    [NR.__NR_symlink, (ctx, args) => {
        const destination = user_parent(ctx, args[1]);
        if (destination.err) return destination;
        return vfs_symlink(
            destination.val[0], destination.val[1], args[0],
            ctx.effective_uid, ctx.effective_gid, ctx.task.groups);
    }],
    [NR.__NR_readlink, (ctx, args) => {
        const found = user_lstat(ctx, args[0]);
        return found.err ? found : vfs_readlink(found.val);
    }],
    [NR.__NR_realpath, (ctx, args) =>
        path_realpath_user(
            path_from_cwd(args[0], ctx.task.cwd),
            ctx.effective_uid, ctx.effective_gid, ctx.task.groups)],
    [NR.__NR_open, (ctx, args) =>
        open_fd(ctx.task, args[0], args[1] ?? O_RDONLY, args[2] ?? 0o666)],
    [NR.__NR_close, (ctx, args) => fd_close(ctx.task, args[0])],
    [NR.__NR_read, (ctx, args) => fd_read(ctx.task, args[0], args[1])],
    [NR.__NR_write, (ctx, args) => fd_write(ctx.task, args[0], args[1])],
    [NR.__NR_lseek, (ctx, args) =>
        fd_lseek(ctx.task, args[0], args[1] ?? 0, args[2] ?? SEEK_SET)],
    [NR.__NR_dup, (ctx, args) => fd_dup(ctx.task, args[0])],
    [NR.__NR_dup2, (ctx, args) => fd_dup(ctx.task, args[0], args[1])],
    [NR.__NR_pipe, ctx => fd_pipe(ctx.task)],
    [NR.__NR_isatty, (ctx, args) => {
        const entry = get_fd(ctx.task, args[0]);
        if (!entry) return {err: -EBADF};
        return {val: is_fd_tty(ctx.task, entry)};
    }],
    [NR.__NR_tcgetattr, (ctx, args) => tcgetattr(ctx.task, args[0])],
    [NR.__NR_tcsetattr, (ctx, args) => tcsetattr(ctx.task, args[0], args[1])],
    [NR.__NR_ioctl, (ctx, args) =>
        fd_ioctl(ctx.task, args[0], args[1], args[2])],

    [NR.__NR_getpid, ctx => ({val: ctx.task.pid})],
    [NR.__NR_getppid, ctx => ({val: ctx.task.ppid})],
    [NR.__NR_getuid, ctx => ({val: ctx.task.uid})],
    [NR.__NR_getgid, ctx => ({val: ctx.task.gid})],
    [NR.__NR_geteuid, ctx => ({val: ctx.task.euid})],
    [NR.__NR_getegid, ctx => ({val: ctx.task.egid})],
    [NR.__NR_getlogin, ctx => ({val: uid_to_username(ctx.task.uid)})],
    [NR.__NR_getgroups, ctx => ({val: [...ctx.task.groups]})],
    [NR.__NR_umask, (ctx, args) => {
        const previous = ctx.task.umask;
        ctx.task.umask = (args[0] ?? previous) & 0o777;
        return {val: previous};
    }],
    [NR.__NR_kill, (ctx, args) => {
        const rc = send_signal(
            ctx.task,
            args[0],
            args[1] ?? SIGTERM,
        );
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_exit, (ctx, args) => {
        do_exit(ctx.task.pid, args[0] ?? 0);
        return {val: args[0] ?? 0};
    }],
    [NR.__NR_wait4, (ctx, args) =>
        do_wait4(ctx.task.pid, args[0] ?? -1, args[1] ?? 0)],
    [NR.__NR_getpgid, (ctx, args) =>
        do_getpgid(ctx.task, args[0] ?? 0)],
    [NR.__NR_setpgid, (ctx, args) =>
        do_setpgid(ctx.task, args[0] ?? 0, args[1] ?? 0)],
    [NR.__NR_getsid, (ctx, args) =>
        do_getsid(ctx.task, args[0] ?? 0)],
    [NR.__NR_setsid, ctx => do_setsid(ctx.task)],
    [NR.__NR_setuid, (ctx, args) => {
        if (!Number.isInteger(args[0]) || args[0] < 0) return {err: -EINVAL};
        const rc = do_setuid(ctx.task, args[0]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_setgid, (ctx, args) => {
        if (!Number.isInteger(args[0]) || args[0] < 0) return {err: -EINVAL};
        const rc = do_setgid(ctx.task, args[0]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_setgroups, (ctx, args) => {
        if (!Array.isArray(args[0]) ||
            args[0].some(gid => !Number.isInteger(gid) || gid < 0))
            return {err: -EINVAL};
        const rc = do_setgroups(ctx.task, args[0]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],

    [NR.__NR_useradd, (ctx, args) => {
        const rc = sys_useradd(ctx.task.euid, args[0], args[1] ?? {});
        if (rc < 0) return {err: rc};
        const entry = getpwnam(args[0]);
        const home = entry?.home ?? args[1]?.home ?? `/home/${args[0]}`;
        const made = do_syscall(ctx.pid, NR.__NR_mkdir, [home, 0o755]);
        if (!made.err && entry)
            do_syscall(ctx.pid, NR.__NR_chown, [home, entry.uid, entry.gid]);
        return {val: 0};
    }],
    [NR.__NR_userdel, (ctx, args) => {
        const rc = sys_userdel(ctx.task.euid, args[0]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_usermod, (ctx, args) => {
        const rc = sys_usermod(ctx.task.euid, args[0], args[1] ?? {});
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_groupadd, (ctx, args) => {
        const rc = sys_groupadd(ctx.task.euid, args[0], args[1]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_groupdel, (ctx, args) => {
        const rc = sys_groupdel(ctx.task.euid, args[0]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_groupmod, (ctx, args) => {
        const rc = sys_groupmod(ctx.task.euid, args[0], args[1] ?? {});
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_groupmem, (ctx, args) => {
        const rc = sys_group_member(
            ctx.task.euid, args[0], args[1], args[2]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_passwd, (ctx, args) => {
        const rc = sys_passwd(ctx.task.euid, args[0], args[1]);
        return rc < 0 ? {err: rc} : {val: 0};
    }],
    [NR.__NR_su, (ctx, args) => {
        const entry = (
            ctx.task.uid === ROOT_UID &&
            ctx.task.euid === ROOT_UID &&
            args[1] === undefined
        )
            ? getpwnam(args[0])
            : authenticate(args[0], args[1]);
        if (!entry) return {err: -EACCES};
        ctx.task.uid = ctx.task.euid = entry.uid;
        ctx.task.gid = ctx.task.egid = entry.gid;
        ctx.task.suid = entry.uid;
        ctx.task.sgid = entry.gid;
        ctx.task.groups = [...entry.groups];
        ctx.task.ring = entry.uid === ROOT_UID ? RING_ROOT : RING_USER;
        ctx.task.envp.USER = entry.username;
        ctx.task.envp.HOME = entry.home;
        ctx.task.envp.SHELL = entry.shell;
        return {val: entry};
    }],
    [NR.__NR_getpwnam, (_ctx, args) => ({val: getpwnam(args[0])})],
    [NR.__NR_getpwuid, (_ctx, args) => ({val: getpwuid(args[0])})],
    [NR.__NR_getgrnam, (_ctx, args) => ({val: getgrnam(args[0])})],
    [NR.__NR_getgrgid, (_ctx, args) => ({val: getgrgid(args[0])})],

    [NR.__NR_uname, () => ({
        val: {
            sysname: 'JSNix',
            nodename: read_kernel_config('/etc/hostname', 'jsnix'),
            release: '0.1.0-jsnix',
            version: `#1 SMP ${new Date(kernel_boot_time).toUTCString()}`,
            machine: 'js-x64',
        },
    })],
    [NR.__NR_time, () => ({val: Math.floor(Date.now() / 1000)})],
    [NR.__NR_getenv, (ctx, args) => ({val: ctx.task.envp[args[0]] ?? null})],
    [NR.__NR_setenv, (ctx, args) => {
        ctx.task.envp[args[0]] = args[1];
        return {val: 0};
    }],
    [NR.__NR_unsetenv, (ctx, args) => {
        delete ctx.task.envp[args[0]];
        return {val: 0};
    }],
    [NR.__NR_syslog, (_ctx, args) => {
        printk(args[0]);
        return {val: 0};
    }],
    [NR.__NR_sysinfo, () => ({
        val: {
            uptime: Math.floor((Date.now() - kernel_boot_time) / 1000),
            totalram: 1048576,
            freeram: 524288,
            procs: task_table.size,
        },
    })],
    [NR.__NR_reboot, (ctx, args) => {
        if (ctx.task.euid !== ROOT_UID) return {err: -EPERM};
        const action = args[0] ?? 'restart';
        const rc = kernel_power_request(action, ctx.task.pid);
        if (rc < 0) return {err: rc};
        printk(`kernel: power action requested: ${action}`);
        return {val: 0};
    }],
]);

export function do_syscall(pid, nr, args) {
    const task = task_table.get(pid);
    if (!task || task.state === TASK_ZOMBIE) return {err: -ESRCH};

    const handler = syscall_handlers.get(nr);
    if (!handler) return {err: -ENOSYS};
    if (syscall_needs_proc_refresh(task, args))
        proc_update(task_table, kernel_boot_time, pid);
    return handler({
        pid,
        task,
        effective_uid: task.euid,
        effective_gid: task.egid,
    }, args);
}

export function kernel_init() {
    const pid1 = do_fork('init', ROOT_UID, ROOT_GID, '/', 0);
    printk('kernel_init: JSNix 0.1.0 booting');
    printk(`kernel_init: arch=js-x64 boot_time=${kernel_boot_time}`);
    printk('kernel_init: rootfs mounted at /');
    printk(`kernel_init: init started pid=${pid1}`);
    proc_update(task_table, kernel_boot_time);
    return pid1;
}
