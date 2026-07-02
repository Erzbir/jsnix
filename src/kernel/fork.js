/**
 * kernel/fork.js - Process creation
 *
 * Analogous to kernel/fork.c.
 */

'use strict';

import {task_struct_alloc} from './mm/slab.js';
import {alloc_pid} from './pid.js';
import {task_table} from './sched/core.js';
import {init_exit_handlers} from './exit.js';
import {clone_fdtable} from './fs/file.js';
import {
    getpwuid,
    uid_to_home,
    uid_to_username,
} from './security/credentials.js';

export function do_fork(comm, uid, gid, cwd, ppid) {
    const task = task_struct_alloc(comm, uid, gid, cwd, ppid);
    task.pid = alloc_pid();

    if (ppid && task_table.has(ppid)) {
        const parent = task_table.get(ppid);
        task.pgid = parent.pgid;
        task.sid = parent.sid;
        task.groups = parent.uid === uid
            ? [...parent.groups]
            : [...(getpwuid(uid)?.groups ?? [gid])];
        task.umask = parent.umask;
        task.envp = {
            ...parent.envp,
            PWD: cwd ?? parent.cwd,
            USER: uid_to_username(uid),
            HOME: uid_to_home(uid),
        };
        task.tty = parent.tty;
        task.controlling_tty = parent.controlling_tty;
        task.fdt = clone_fdtable(parent.fdt);
    } else {
        task.pgid = task.pid;
        task.sid = task.pid;
        task.groups = [...(getpwuid(uid)?.groups ?? [gid])];
        task.envp.USER = uid_to_username(uid);
        task.envp.HOME = uid_to_home(uid);
    }

    task_table.set(task.pid, task);
    init_exit_handlers(task.pid);
    return task.pid;
}
