/**
 * kernel/wait.js - Child state collection and zombie reaping
 *
 * Analogous to kernel/exit.c wait_task_zombie() and do_wait().
 */

'use strict';

import {
    EAGAIN,
    ECHILD,
    SIGSTOP,
    TASK_STOPPED,
    TASK_ZOMBIE,
    WCONTINUED,
    WNOHANG,
    WUNTRACED,
} from './include/types.js';
import {reap_task} from './exit.js';
import {task_table} from './sched/core.js';

function wait_status(task) {
    if (task.exit_signal) return task.exit_signal & 0x7f;
    return (task.exit_code & 0xff) << 8;
}

export function do_wait4(parent_pid, requested_pid = -1, options = 0) {
    const parent = task_table.get(parent_pid);
    const children = [...task_table.values()].filter(task =>
        task.ppid === parent_pid &&
        (requested_pid === -1 ||
            (requested_pid > 0 && task.pid === requested_pid) ||
            (requested_pid === 0 && task.pgid === parent?.pgid) ||
            (requested_pid < -1 && task.pgid === -requested_pid)));
    if (!children.length) return {err: -ECHILD};

    const zombie = children.find(task => task.state === TASK_ZOMBIE);
    if (zombie) {
        const result = {
            pid: zombie.pid,
            status: wait_status(zombie),
            exit_code: zombie.exit_signal ? null : zombie.exit_code,
            signal: zombie.exit_signal || null,
        };
        reap_task(zombie.pid);
        return {val: result};
    }

    const stopped = (options & WUNTRACED) && children.find(task =>
        task.state === TASK_STOPPED && !task.stop_reported);
    if (stopped) {
        stopped.stop_reported = true;
        return {val: {
            pid: stopped.pid,
            status: (SIGSTOP << 8) | 0x7f,
            exit_code: null,
            signal: SIGSTOP,
        }};
    }

    const continued = (options & WCONTINUED) && children.find(task =>
        task.continued_pending);
    if (continued) {
        continued.continued_pending = false;
        return {val: {
            pid: continued.pid,
            status: 0xffff,
            exit_code: null,
            signal: null,
        }};
    }

    if (options & WNOHANG) return {val: {pid: 0, status: 0}};
    // The synchronous JS syscall facade cannot suspend the host call stack.
    // Async process runners wake and retry this operation after child exit.
    return {err: -EAGAIN};
}
