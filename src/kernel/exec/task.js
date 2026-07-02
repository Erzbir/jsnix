/**
 * kernel/exec/task.js - Task changes made by execve
 *
 * Analogous to fs/exec.c credential and image setup.
 */

'use strict';

import {
    RING_ROOT,
    RING_USER,
    ROOT_UID,
    S_ISGID,
    S_ISUID,
} from '../include/types.js';
import {task_table} from '../sched/core.js';
import {install_task_fd} from '../fs/file.js';

export function bind_exec_resources(pid, image) {
    const task = task_table.get(pid);
    if (!task) return false;
    const tty = task.tty;

    task.comm = image.comm;
    task.executable = image.executable;
    task.argv = [...image.argv];
    const preserve = new Set(image.preserve_fds ?? []);
    if (!preserve.has(0)) install_task_fd(task, 0, {
            path: '/dev/stdin',
            flags: 'r',
            kind: 'stdio',
            readable: true,
            writable: false,
            offset: 0,
            input: String(image.stdin ?? ''),
            tty,
            refcount: 1,
        });
    if (!preserve.has(1)) install_task_fd(task, 1, {
            path: '/dev/stdout',
            flags: 'w',
            kind: 'stdio',
            readable: false,
            writable: true,
            offset: 0,
            output: image.stdout,
            tty,
            refcount: 1,
        });
    if (!preserve.has(2)) install_task_fd(task, 2, {
            path: '/dev/stderr',
            flags: 'w',
            kind: 'stdio',
            readable: false,
            writable: true,
            offset: 0,
            output: image.stderr,
            tty,
            refcount: 1,
        });
    task.mm = {
        format: image.format,
        image_size: image.image_size,
    };
    return true;
}

export function prepare_exec_credentials(pid, parent_pid, inode) {
    const task = task_table.get(pid);
    const parent = task_table.get(parent_pid);
    if (!task || !parent || !inode) return false;

    task.uid = parent.uid;
    task.gid = parent.gid;
    task.euid = parent.euid;
    task.egid = parent.egid;
    task.suid = parent.suid ?? parent.euid;
    task.sgid = parent.sgid ?? parent.egid;
    task.groups = [...parent.groups];

    if (inode.i_mode & S_ISUID) task.euid = inode.i_uid;
    if (inode.i_mode & S_ISGID) task.egid = inode.i_gid;

    task.suid = task.euid;
    task.sgid = task.egid;
    task.ring = task.euid === ROOT_UID ? RING_ROOT : RING_USER;
    return true;
}
