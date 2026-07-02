/**
 * kernel/signal.js - Signal delivery
 *
 * Analogous to kernel/signal.c.
 */

'use strict';

import {
    EINVAL,
    EPERM,
    ESRCH,
    INIT_PID,
    ROOT_UID,
    SIGCONT,
    SIGSTOP,
    TASK_RUNNING,
    TASK_STOPPED,
    TASK_ZOMBIE,
} from './include/types.js';
import {do_exit} from './exit.js';
import {set_task_state, task_table} from './sched/core.js';

function deliver_signal(sender, task, signo) {
    if (!task || task.state === TASK_ZOMBIE) return -ESRCH;
    const target_pid = task.pid;
    const sender_uid = typeof sender === 'number' ? sender : sender?.uid;
    const sender_euid = typeof sender === 'number' ? sender : sender?.euid;
    const session_continue = signo === SIGCONT &&
        typeof sender !== 'number' && sender?.sid === task.sid;
    const allowed = session_continue || sender_euid === ROOT_UID ||
        [sender_uid, sender_euid].some(uid =>
            uid === task.uid || uid === task.suid);
    if (!allowed) return -EPERM;
    if (target_pid === INIT_PID && signo !== 0) return -EPERM;
    if (signo === 0) return 0;

    if (signo === SIGSTOP) {
        task.stop_reported = false;
        task.continued_pending = false;
        set_task_state(task.pid, TASK_STOPPED);
        return 0;
    }
    if (signo === SIGCONT) {
        if (task.state === TASK_STOPPED)
            set_task_state(task.pid, TASK_RUNNING);
        task.continued_pending = true;
        return 0;
    }

    do_exit(target_pid, 128 + signo, signo);
    return 0;
}

export function send_signal(sender, target_pid, signo) {
    if (!Number.isInteger(signo) || signo < 0 || signo > 64) return -EINVAL;
    if (!Number.isInteger(target_pid)) return -EINVAL;
    if (target_pid > 0)
        return deliver_signal(sender, task_table.get(target_pid), signo);

    const sender_task = typeof sender === 'number' ? null : sender;
    if (!sender_task) return -EINVAL;
    let targets;
    if (target_pid === 0) {
        targets = [...task_table.values()].filter(task =>
            task.pgid === sender_task.pgid);
    } else if (target_pid === -1) {
        targets = [...task_table.values()].filter(task =>
            task.pid !== INIT_PID && task.pid !== sender_task.pid);
    } else {
        targets = [...task_table.values()].filter(task =>
            task.pgid === -target_pid);
    }
    if (!targets.length) return -ESRCH;

    let denied = false;
    let delivered = false;
    for (const task of targets) {
        const result = deliver_signal(sender, task, signo);
        if (result === 0) delivered = true;
        else if (result === -EPERM) denied = true;
    }
    if (delivered) return 0;
    return denied ? -EPERM : -ESRCH;
}
