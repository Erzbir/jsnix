/**
 * kernel/exit.js - Process exit and exit handlers
 *
 * Analogous to kernel/exit.c.
 */

'use strict';

import {INIT_PID, TASK_ZOMBIE} from './include/types.js';
import {kernel_panic} from './power.js';
import {task_table} from './sched/core.js';
import {release_task_files} from './fs/file.js';

const exit_handler_table = new Map();

export function reset_exit_handlers() {
    exit_handler_table.clear();
}

export function init_exit_handlers(pid) {
    exit_handler_table.set(pid, {});
}

function reparent_children(dead_pid) {
    for (const [, child] of task_table) {
        if (child.pid !== dead_pid &&
            child.ppid === dead_pid)
            child.ppid = INIT_PID;
    }
}

export function do_exit(pid, exit_code, exit_signal = 0) {
    const task = task_table.get(pid);
    if (!task) return;
    if (task.state === TASK_ZOMBIE) return;

    task.state = TASK_ZOMBIE;
    task.exit_code = exit_code ?? 0;
    task.exit_signal = exit_signal ?? 0;
    release_task_files(task);
    if (pid !== INIT_PID) reparent_children(pid);

    const handlers = exit_handler_table.get(pid) ?? {};
    for (const fn of Object.values(handlers)) {
        try {
            fn(pid, task.exit_code);
        } catch {
            /* Ignore exit handler failures. */
        }
    }

    if (pid === INIT_PID) {
        kernel_panic(`init exited with status ${task.exit_code}`, pid);
        return;
    }
}

export function reap_task(pid) {
    const task = task_table.get(pid);
    if (!task || task.state !== TASK_ZOMBIE) return null;
    task_table.delete(pid);
    exit_handler_table.delete(pid);
    return task;
}

export function register_exit_handler(pid, key, fn) {
    if (!exit_handler_table.has(pid)) exit_handler_table.set(pid, {});
    exit_handler_table.get(pid)[key] = fn;
}

export function unregister_exit_handler(pid, key) {
    exit_handler_table.get(pid) && delete exit_handler_table.get(pid)[key];
}
