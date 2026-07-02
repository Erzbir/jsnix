/**
 * kernel/fs/vfs.js
 *
 * Analogous to:
 *   fs/namei.c        - path_lookup, path_resolve, and path_parent
 *   fs/inode.c        - inode_permission
 *   fs/read_write.c   - vfs_read and vfs_write
 *   fs/stat.c         - vfs_stat
 *   fs/namei.c        - vfs_mkdir, vfs_unlink, vfs_rmdir, and vfs_rename
 *   fs/readdir.c      - vfs_readdir
 *   fs/attr.c         - vfs_chmod and vfs_chown
 *   fs/proc/base.c    - proc_update
 */

'use strict';

import {
    EACCES,
    EEXIST,
    EINVAL,
    EISDIR,
    ELOOP,
    ENOENT,
    ENOTDIR,
    ENOTEMPTY,
    EPERM,
    MAY_EXEC,
    MAY_READ,
    MAY_WRITE,
    ROOT_UID,
    S_IFCHR,
    S_IFDIR,
    S_IFLNK,
    S_IFREG,
    S_ISGID,
    S_ISUID,
    S_ISVTX,
    TASK_ZOMBIE,
} from '../include/types.js';
import {inode_alloc} from '../mm/slab.js';
import {byte_length} from './bytes.js';

// Empty superblock skeleton populated by init/rootfs/index.js.
// Analogous to struct super_block and mount_root().
// Only structural directories exist here. No user data.
function create_initial_superblock() {
    const dir = (mode, uid, gid) =>
        Object.assign(inode_alloc(S_IFDIR, mode, uid, gid), {i_data: {}});
    const link = target => inode_alloc(S_IFLNK, 0o777, 0, 0, target);
    const root_dir = dir(0o755, 0, 0);
    root_dir.i_data = {
        bin: link('/usr/bin'),
        boot: dir(0o755, 0, 0),
        dev: dir(0o755, 0, 0),
        etc: dir(0o755, 0, 0),
        home: dir(0o755, 0, 0),
        lib: link('/usr/lib'),
        lib64: link('/usr/lib64'),
        media: dir(0o755, 0, 0),
        mnt: dir(0o755, 0, 0),
        opt: dir(0o755, 0, 0),
        proc: dir(0o555, 0, 0),
        root: dir(0o700, 0, 0),
        run: dir(0o755, 0, 0),
        sbin: link('/usr/sbin'),
        srv: dir(0o755, 0, 0),
        sys: dir(0o555, 0, 0),
        tmp: dir(0o1777, 0, 0),
        usr: dir(0o755, 0, 0),
        var: dir(0o755, 0, 0),
    };
    root_dir.i_nlink = 2 + Object.values(root_dir.i_data)
        .filter(inode => inode.i_type === 'dir').length;
    return root_dir;
}

let jsfs_sb = create_initial_superblock();

export function vfs_reset() {
    jsfs_sb = create_initial_superblock();
}

// Resolve a path against a current working directory.
export function path_resolve(path, cwd) {
    if (!path) return cwd ?? '/';
    if (!path.startsWith('/'))
        path = (cwd ?? '/').replace(/\/?$/, '/') + path;
    const stack = [];
    for (const part of path.split('/').filter(Boolean)) {
        if (part === '.') continue;
        if (part === '..') {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    return '/' + stack.join('/');
}

// Make a path absolute without collapsing components. Kernel pathname lookup
// must process `..` after following a preceding symlink, not before it.
export function path_from_cwd(path, cwd = '/') {
    path = String(path ?? '');
    if (path === '') return '';
    if (path.startsWith('/')) return path;
    const base = String(cwd || '/').replace(/\/+$/, '');
    return `${base || '/'}${base ? '/' : ''}${path}`;
}

// Look up an absolute path without permission checks.
export function path_lookup(abs) {
    return path_lookup_internal(abs, true);
}

export function path_lstat(abs) {
    return path_lookup_internal(abs, false);
}

function path_lookup_internal(abs, follow_final, depth = 0) {
    const result = walk_path(abs, follow_final, null, depth);
    return result.err ? null : result.val;
}

function has_remaining_component(parts) {
    return parts.some(part => part !== '' && part !== '.');
}

function walk_path(raw_path, follow_final, credentials = null, depth = 0) {
    if (raw_path === '' || raw_path === null || raw_path === undefined)
        return {err: -ENOENT};
    if (String(raw_path).includes('\0')) return {err: -EINVAL};
    const absolute = path_from_cwd(raw_path, '/');
    const parts = absolute.split('/');
    const nodes = [jsfs_sb];
    const names = [];
    let node = jsfs_sb;
    let symlinks = depth;

    while (parts.length) {
        const name = parts.shift();
        if (!name || name === '.') continue;
        if (!node || node.i_type !== 'dir') return {err: -ENOTDIR};
        if (credentials && inode_permission(
            node,
            credentials.uid,
            credentials.gid,
            MAY_EXEC,
            credentials.groups,
        ) < 0)
            return {err: -EACCES};

        if (name === '..') {
            if (nodes.length > 1) {
                nodes.pop();
                names.pop();
            }
            node = nodes.at(-1);
            continue;
        }

        const child = node.i_data[name] ?? null;
        if (!child) return {err: -ENOENT};
        const is_final = !has_remaining_component(parts);
        if (child.i_type === 'link' && (follow_final || !is_final)) {
            if (++symlinks > 40) return {err: -ELOOP};
            const target = String(child.i_data ?? '');
            if (target.startsWith('/')) {
                nodes.splice(1);
                names.length = 0;
                node = jsfs_sb;
            }
            parts.unshift(...target.split('/'));
            continue;
        }

        node = child;
        nodes.push(node);
        names.push(name);
    }

    if (absolute.length > 1 && absolute.endsWith('/') && node.i_type !== 'dir')
        return {err: -ENOTDIR};
    return {val: node, path: '/' + names.join('/')};
}

// Look up a path for a user. Each parent directory must be searchable.
export function path_lookup_user(
    abs, uid, gid, groups = [], follow_final = true, depth = 0) {
    return walk_path(abs, follow_final, {uid, gid, groups}, depth);
}

export function path_lstat_user(abs, uid, gid, groups = []) {
    return path_lookup_user(abs, uid, gid, groups, false);
}

export function path_realpath_user(abs, uid, gid, groups = [], depth = 0) {
    const result = walk_path(abs, true, {uid, gid, groups}, depth);
    return result.err ? result : {val: result.path};
}

// Resolve the parent directory and base name of a path.
export function path_parent(abs) {
    const result = split_parent_path(abs);
    if (!result) return [null, '', '/'];
    const parent = walk_path(result.parent, true);
    return parent.err
        ? [null, result.name, result.parent]
        : [parent.val, result.name, parent.path];
}

export function path_parent_user(abs, uid, gid, groups = []) {
    const split = split_parent_path(abs);
    if (!split) return {err: -ENOENT};
    if (split.name === '.' || split.name === '..') return {err: -EINVAL};
    const result = path_lookup_user(split.parent, uid, gid, groups);
    if (result.err) return result;
    return {val: [result.val, split.name, result.path]};
}

function split_parent_path(raw_path) {
    if (raw_path === '' || raw_path === null || raw_path === undefined)
        return null;
    let path = path_from_cwd(raw_path, '/').replace(/\/+$/, '');
    if (!path) path = '/';
    if (path === '/') return null;
    const slash = path.lastIndexOf('/');
    return {
        parent: path.slice(0, slash) || '/',
        name: path.slice(slash + 1),
    };
}

// Check inode permissions for a user and group set.
export function inode_permission(inode, uid, gid, mask, groups = []) {
    if (uid === ROOT_UID) {
        if (inode.i_type === 'file' &&
            (mask & MAY_EXEC) &&
            !(inode.i_mode & 0o111))
            return -EACCES;
        return 0;
    }
    const in_group = inode.i_gid === gid || groups.includes(inode.i_gid);
    const shift = inode.i_uid === uid ? 6 : in_group ? 3 : 0;
    const bits = (inode.i_mode >> shift) & 7;
    return (bits & mask) === mask ? 0 : -EACCES;
}

// VFS operations.

export function vfs_read(inode, uid, gid, groups = []) {
    if (inode.i_type === 'char') {
        if (inode_permission(inode, uid, gid, MAY_READ, groups) < 0)
            return {err: -EACCES};
        if (inode.i_device === 'zero') return {val: '\0'};
        if (inode.i_device === 'random' || inode.i_device === 'urandom')
            return {val: random_bytes(32)};
        return {val: ''};
    }
    if (inode.i_type !== 'file') return {err: -EISDIR};
    if (inode_permission(inode, uid, gid, MAY_READ, groups) < 0)
        return {err: -EACCES};
    inode.i_atime = Date.now();
    const data = typeof inode.i_data === 'function' ? inode.i_data() : inode.i_data;
    return {val: data};
}

function random_bytes(length) {
    const bytes = new Uint8Array(length);
    const crypto = globalThis.crypto;
    if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
    else {
        for (let index = 0; index < bytes.length; index++)
            bytes[index] = Math.floor(Math.random() * 256);
    }
    return String.fromCharCode(...bytes);
}

export function vfs_write(inode, uid, gid, data, append, groups = []) {
    if (inode.i_type === 'char') {
        if (inode_permission(inode, uid, gid, MAY_WRITE, groups) < 0)
            return {err: -EACCES};
        return {val: byte_length(data)};
    }
    if (inode.i_type !== 'file') return {err: -EISDIR};
    if (inode_permission(inode, uid, gid, MAY_WRITE, groups) < 0)
        return {err: -EACCES};
    inode.i_data = append ? (inode.i_data + data) : data;
    inode.i_mode &= ~(S_ISUID | S_ISGID);
    inode.i_mtime = inode.i_ctime = Date.now();
    inode.i_size = byte_length(inode.i_data);
    return {val: byte_length(data)};
}

export function vfs_create(parent, name, mode, uid, gid, data = '', groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    if (parent.i_data[name]) return {err: -EEXIST};
    const file_gid = (parent.i_mode & S_ISGID) ? parent.i_gid : gid;
    parent.i_data[name] = inode_alloc(
        S_IFREG, mode ?? 0o666, uid, file_gid, data);
    parent.i_mtime = parent.i_ctime = Date.now();
    return {val: byte_length(data)};
}

export function vfs_link(parent, name, inode, uid, gid, groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode.i_type === 'dir') return {err: -EPERM};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    if (parent.i_data[name]) return {err: -EEXIST};
    parent.i_data[name] = inode;
    inode.i_nlink++;
    inode.i_ctime = Date.now();
    parent.i_mtime = parent.i_ctime = Date.now();
    return {val: 0};
}

export function vfs_symlink(
    parent, name, target, uid, gid, groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    if (parent.i_data[name]) return {err: -EEXIST};
    parent.i_data[name] = inode_alloc(S_IFLNK, 0o777, uid, gid, target);
    parent.i_mtime = parent.i_ctime = Date.now();
    return {val: 0};
}

export function vfs_readlink(inode) {
    if (inode.i_type !== 'link') return {err: -EINVAL};
    return {val: inode.i_data};
}

export function vfs_stat(inode) {
    return {
        st_mode: inode.i_mode,
        st_uid: inode.i_uid,
        st_gid: inode.i_gid,
        st_size: inode.i_type === 'file' || inode.i_type === 'link'
            ? byte_length(typeof inode.i_data === 'function'
                ? inode.i_data()
                : inode.i_data)
            : 0,
        st_nlink: inode.i_nlink,
        st_mtime: inode.i_mtime,
        st_atime: inode.i_atime,
        st_ctime: inode.i_ctime,
        type: inode.i_type,
    };
}

export function vfs_mkdir(parent, name, mode, uid, gid, groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    if (parent.i_data[name]) return {err: -EEXIST};
    const inherit_group = Boolean(parent.i_mode & S_ISGID);
    const dir_gid = inherit_group ? parent.i_gid : gid;
    const dir_mode = (mode ?? 0o755) | (inherit_group ? S_ISGID : 0);
    parent.i_data[name] = inode_alloc(S_IFDIR, dir_mode, uid, dir_gid);
    parent.i_nlink++;
    parent.i_mtime = parent.i_ctime = Date.now();
    return {val: 0};
}

export function vfs_unlink(parent, name, uid, gid, groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    const inode = parent.i_data[name];
    if (!inode) return {err: -ENOENT};
    if (inode.i_type === 'dir') return {err: -EISDIR};
    if (sticky_denied(parent, inode, uid)) return {err: -EPERM};
    delete parent.i_data[name];
    inode.i_nlink = Math.max(0, inode.i_nlink - 1);
    inode.i_ctime = Date.now();
    parent.i_mtime = Date.now();
    return {val: 0};
}

export function vfs_rmdir(parent, name, uid, gid, groups = []) {
    if (parent.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    const inode = parent.i_data[name];
    if (!inode) return {err: -ENOENT};
    if (inode.i_type !== 'dir') return {err: -ENOTDIR};
    if (sticky_denied(parent, inode, uid)) return {err: -EPERM};
    if (Object.keys(inode.i_data).length) return {err: -ENOTEMPTY};
    delete parent.i_data[name];
    inode.i_nlink = 0;
    inode.i_ctime = Date.now();
    parent.i_nlink = Math.max(2, parent.i_nlink - 1);
    parent.i_mtime = parent.i_ctime = Date.now();
    return {val: 0};
}

export function vfs_rename(
    src_parent, src_name, dst_parent, dst_name, uid, gid, groups = []) {
    if (src_parent.i_type !== 'dir' || dst_parent.i_type !== 'dir')
        return {err: -ENOTDIR};
    if (inode_permission(
        src_parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0 ||
        inode_permission(
            dst_parent, uid, gid, MAY_WRITE | MAY_EXEC, groups) < 0)
        return {err: -EACCES};
    const source = src_parent.i_data[src_name];
    if (!source) return {err: -ENOENT};
    if (src_parent === dst_parent && src_name === dst_name) return {val: 0};
    if (sticky_denied(src_parent, source, uid)) return {err: -EPERM};
    const target = dst_parent.i_data[dst_name];
    if (target === source) return {val: 0};
    if (target && sticky_denied(dst_parent, target, uid)) return {err: -EPERM};

    if (source.i_type === 'dir' && directory_contains(source, dst_parent))
        return {err: -EINVAL};
    if (target) {
        if (source.i_type === 'dir' && target.i_type !== 'dir')
            return {err: -ENOTDIR};
        if (source.i_type !== 'dir' && target.i_type === 'dir')
            return {err: -EISDIR};
        if (target.i_type === 'dir' && Object.keys(target.i_data).length)
            return {err: -ENOTEMPTY};
    }

    if (target) {
        if (target.i_type === 'dir') {
            target.i_nlink = 0;
            dst_parent.i_nlink = Math.max(2, dst_parent.i_nlink - 1);
        } else {
            target.i_nlink = Math.max(0, target.i_nlink - 1);
        }
        target.i_ctime = Date.now();
    }

    dst_parent.i_data[dst_name] = source;
    delete src_parent.i_data[src_name];
    if (source.i_type === 'dir' && src_parent !== dst_parent) {
        src_parent.i_nlink = Math.max(2, src_parent.i_nlink - 1);
        dst_parent.i_nlink++;
    }
    source.i_ctime = Date.now();
    src_parent.i_mtime = src_parent.i_ctime = Date.now();
    dst_parent.i_mtime = dst_parent.i_ctime = Date.now();
    return {val: 0};
}

function directory_contains(directory, candidate, seen = new Set()) {
    if (directory === candidate) return true;
    if (directory.i_type !== 'dir' || seen.has(directory)) return false;
    seen.add(directory);
    return Object.values(directory.i_data).some(child =>
        child.i_type === 'dir' && directory_contains(child, candidate, seen));
}

export function vfs_readdir(inode, uid, gid, groups = []) {
    if (inode.i_type !== 'dir') return {err: -ENOTDIR};
    if (inode_permission(inode, uid, gid, MAY_READ, groups) < 0)
        return {err: -EACCES};
    inode.i_atime = Date.now();
    return {val: Object.keys(inode.i_data).sort()};
}

export function vfs_chmod(inode, mode, uid, groups = []) {
    if (uid !== ROOT_UID && inode.i_uid !== uid) return {err: -EPERM};
    if (uid !== ROOT_UID &&
        (mode & S_ISGID) &&
        !groups.includes(inode.i_gid))
        mode &= ~S_ISGID;
    inode.i_mode = (inode.i_mode & 0o170000) | (mode & 0o7777);
    inode.i_ctime = Date.now();
    return {val: 0};
}

export function vfs_chown(
    inode, new_uid, new_gid, caller_uid, caller_groups = []) {
    if (caller_uid !== ROOT_UID) {
        if (inode.i_uid !== caller_uid || new_uid !== -1)
            return {err: -EPERM};
        if (new_gid !== -1 && !caller_groups.includes(new_gid))
            return {err: -EPERM};
    }
    if (new_uid !== -1) inode.i_uid = new_uid;
    if (new_gid !== -1) inode.i_gid = new_gid;
    inode.i_mode &= ~(S_ISUID | S_ISGID);
    inode.i_ctime = Date.now();
    return {val: 0};
}

function sticky_denied(parent, inode, uid) {
    return Boolean(parent.i_mode & S_ISVTX) &&
        uid !== ROOT_UID &&
        uid !== parent.i_uid &&
        uid !== inode.i_uid;
}

// Update the simulated proc file system.
// Analogous to fs/proc/base.c.
export function proc_update(task_table, kernel_boot_time, current_pid = 1) {
    const proc = path_lookup('/proc');
    if (!proc) return;
    proc.i_data = {};
    const ro = content => inode_alloc(S_IFREG, 0o444, 0, 0, content);
    const link = target => inode_alloc(S_IFLNK, 0o777, 0, 0, target);

    for (const [pid, task] of task_table) {
        const pid_dir = inode_alloc(S_IFDIR, 0o555, task.uid, task.gid);
        const fd_dir = inode_alloc(S_IFDIR, 0o500, task.uid, task.gid);
        fd_dir.i_data = Object.fromEntries(
            Object.entries(task.fdt).map(([fd, resource]) => [
                fd,
                link(resource.path ?? '/dev/pts/0'),
            ])
        );
        const task_dir = inode_alloc(S_IFDIR, 0o555, task.uid, task.gid);
        task_dir.i_data[String(pid)] = link(`/proc/${pid}`);
        pid_dir.i_data = {
            status: inode_alloc(S_IFREG, 0o444, task.uid, task.gid, () =>
                `Name:\t${task.comm}\n` +
                `State:\t${task.state} (${task_state_name(task.state)})\n` +
                `Pid:\t${task.pid}\n` +
                `PPid:\t${task.ppid}\n` +
                `NSpgid:\t${task.pgid}\n` +
                `NSsid:\t${task.sid}\n` +
                `Uid:\t${task.uid}\t${task.euid}\t${task.uid}\t${task.euid}\n` +
                `Gid:\t${task.gid}\t${task.egid}\t${task.gid}\t${task.egid}\n` +
                `Groups:\t${task.groups.join(' ')}\n` +
                'Threads:\t1\n'),
            cmdline: inode_alloc(
                S_IFREG, 0o444, task.uid, task.gid, () =>
                    `${(task.argv ?? [task.comm]).join('\0')}\0`),
            environ: inode_alloc(S_IFREG, 0o400, task.uid, task.gid, () =>
                Object.entries(task.envp).map(([k, v]) => `${k}=${v}`).join('\0')),
            cwd: link(task.cwd),
            root: link('/'),
            exe: link(
                task.executable ??
                (task.comm === 'init'
                    ? '/usr/sbin/init'
                    : task.comm === 'bash'
                        ? '/usr/bin/bash'
                        : `/usr/bin/${task.comm}`)),
            fd: fd_dir,
            task: task_dir,
            mounts: ro(
                'jsfs / jsfs rw,relatime 0 0\n' +
                'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n' +
                'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\n' +
                'tmpfs /run tmpfs rw,nosuid,nodev,mode=755 0 0\n'),
        };
        proc.i_data[String(pid)] = pid_dir;
    }

    proc.i_data['self'] = link(String(current_pid));
    proc.i_data['thread-self'] = link(`${current_pid}/task/${current_pid}`);
    proc.i_data['version'] = ro(
        'Linux version 0.1.0-jsnix (jsnix@localhost) ' +
        '(JavaScript Virtual Compiler) #1 SMP\n');
    proc.i_data['cmdline'] = ro('BOOT_IMAGE=/boot/jsnix root=jsfs rw quiet\n');
    proc.i_data['cpuinfo'] = ro(
        'processor\t: 0\n' +
        'vendor_id\t: JSNix\n' +
        'model name\t: JavaScript Virtual CPU\n' +
        'cpu MHz\t\t: 1000.000\n' +
        'cache size\t: 1024 KB\n' +
        'flags\t\t: fpu tsc cx8 cmov\n\n');
    proc.i_data['loadavg'] = ro('0.01 0.02 0.00 1/1 1\n');
    proc.i_data['meminfo'] = ro(
        'MemTotal:        1048576 kB\n' +
        'MemFree:          524288 kB\n' +
        'MemAvailable:     786432 kB\n' +
        'Buffers:           16384 kB\n' +
        'Cached:           245760 kB\n' +
        'SwapCached:            0 kB\n' +
        'SwapTotal:             0 kB\n' +
        'SwapFree:              0 kB\n');
    proc.i_data['filesystems'] = ro('nodev\tproc\n\tjsfs\n\ttmpfs\n');
    proc.i_data['mounts'] = link('self/mounts');
    proc.i_data['partitions'] = ro(
        'major minor  #blocks  name\n\n' +
        '   8        0    1048576 jsda\n' +
        '   8        1    1047552 jsda1\n');
    proc.i_data['devices'] = ro(
        'Character devices:\n' +
        '  1 mem\n' +
        '  5 /dev/tty\n' +
        '136 pts\n\n' +
        'Block devices:\n' +
        '  8 sd\n');
    proc.i_data['stat'] = ro(
        'cpu  10 0 5 1000 0 0 0 0 0 0\n' +
        'intr 0\n' +
        'ctxt 100\n' +
        'btime ' + Math.floor(kernel_boot_time / 1000) + '\n' +
        'processes ' + task_table.size + '\n' +
        'procs_running 1\n' +
        'procs_blocked 0\n');
    Object.defineProperty(proc.i_data, 'uptime', {
        get() {
            const s = ((Date.now() - kernel_boot_time) / 1000).toFixed(2);
            return inode_alloc(S_IFREG, 0o444, 0, 0, `${s} 0.00\n`);
        },
        configurable: true, enumerable: true,
    });
}

function task_state_name(state) {
    if (state === TASK_ZOMBIE) return 'zombie';
    if (state === 'T') return 'stopped';
    if (state === 'S') return 'sleeping';
    return 'running';
}
