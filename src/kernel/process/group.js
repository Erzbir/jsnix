/**
 * kernel/process/group.js - Process groups and sessions
 *
 * Analogous to setpgid(2), getsid(2), and setsid(2).
 */

'use strict';

import {EPERM, ESRCH} from '../include/types.js';
import {task_table} from '../sched/core.js';

export function do_getpgid(caller, pid = 0) {
    const task = task_table.get(pid || caller.pid);
    return task ? {val: task.pgid} : {err: -ESRCH};
}

export function do_setpgid(caller, pid = 0, pgid = 0) {
    const target = task_table.get(pid || caller.pid);
    if (!target) return {err: -ESRCH};
    if (target.pid !== caller.pid && target.ppid !== caller.pid)
        return {err: -ESRCH};
    if (target.sid !== caller.sid || target.pid === target.sid)
        return {err: -EPERM};

    const next = pgid || target.pid;
    if (next !== target.pid) {
        const group = [...task_table.values()].find(task =>
            task.pgid === next && task.sid === target.sid);
        if (!group) return {err: -EPERM};
    }
    target.pgid = next;
    return {val: 0};
}

export function do_getsid(caller, pid = 0) {
    const task = task_table.get(pid || caller.pid);
    return task ? {val: task.sid} : {err: -ESRCH};
}

export function do_setsid(task) {
    if ([...task_table.values()].some(candidate =>
        candidate.pgid === task.pid))
        return {err: -EPERM};
    task.sid = task.pid;
    task.pgid = task.pid;
    task.controlling_tty = null;
    return {val: task.sid};
}
