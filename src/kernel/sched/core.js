/**
 * kernel/sched/core.js - Scheduler task table and task state
 *
 * Analogous to kernel/sched/core.c.
 */

'use strict';

import {
    TASK_RUNNING,
    TASK_SLEEPING,
    TASK_STOPPED,
    TASK_ZOMBIE,
} from '../include/types.js';
import {reset_exit_handlers} from '../exit.js';
import {reset_pid_allocator} from '../pid.js';

export const task_table = new Map();

export function scheduler_reset() {
    reset_pid_allocator();
    task_table.clear();
    reset_exit_handlers();
}

export function get_task(pid) {
    const task = task_table.get(pid);
    return task ? {...task} : null;
}

export function for_each_task(cb) {
    for (const [, task] of task_table)
        if (task.state !== TASK_ZOMBIE) cb(task);
}

export function set_task_state(pid, state) {
    if (![TASK_RUNNING, TASK_SLEEPING, TASK_STOPPED].includes(state))
        return false;
    const task = task_table.get(pid);
    if (!task || task.state === TASK_ZOMBIE) return false;
    const previous = task.state;
    task.state = state;
    if (previous === TASK_STOPPED && state === TASK_RUNNING) {
        const waiters = task.resume_waiters?.splice(0) ?? [];
        for (const wake of waiters) queueMicrotask(wake);
    }
    return true;
}
