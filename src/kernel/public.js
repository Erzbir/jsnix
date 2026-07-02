/**
 * kernel/public.js - Read-only public kernel view
 *
 * Applications can inspect kernel state through this module without receiving
 * mutation-capable internals such as syscall(), kernel_spawn(), or exec hooks.
 */

'use strict';

import {ksyms} from './ksyms.js';

function task_snapshot(task) {
    return {
        pid: task.pid,
        ppid: task.ppid,
        pgid: task.pgid,
        sid: task.sid,
        comm: task.comm,
        state: task.state,
        uid: task.uid,
        gid: task.gid,
        euid: task.euid,
        egid: task.egid,
        cwd: task.cwd,
        executable: task.executable ?? null,
        argv: [...(task.argv ?? [])],
    };
}

function inode_snapshot(path, inode) {
    if (!inode) return null;
    return {
        path,
        type: inode.i_type,
        mode: inode.i_mode,
        uid: inode.i_uid,
        gid: inode.i_gid,
        size: inode.i_size,
        nlink: inode.i_nlink,
        mtime: inode.i_mtime,
    };
}

export function create_kernel_view() {
    return Object.freeze({
        UTS_RELEASE: ksyms.UTS_RELEASE,
        UTS_MACHINE: ksyms.UTS_MACHINE,
        get boot_time() {
            return ksyms.boot_time;
        },
        get jiffies() {
            return ksyms.jiffies;
        },
        tasks() {
            const tasks = [];
            ksyms.for_each_task(task => tasks.push(task_snapshot(task)));
            return tasks;
        },
        users() {
            return ksyms.list_users()
                .map(name => ksyms.getpwnam(name))
                .filter(Boolean);
        },
        groups() {
            return ksyms.list_groups()
                .map(name => ksyms.getgrnam(name))
                .filter(Boolean);
        },
        getUser(name) {
            return ksyms.getpwnam(name);
        },
        getGroup(name) {
            return ksyms.getgrnam(name);
        },
        stat(path) {
            return inode_snapshot(path, ksyms.path_lookup(path));
        },
        lstat(path) {
            return inode_snapshot(path, ksyms.path_lstat(path));
        },
        resolvePath(path, cwd = '/') {
            return ksyms.path_resolve(path, cwd);
        },
    });
}
