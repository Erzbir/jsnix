/**
 * kernel/process/scheduler.js - Compatibility exports for process lifecycle
 *
 * New code should import from Linux-style modules:
 *   kernel/fork.js
 *   kernel/exit.js
 *   kernel/signal.js
 *   kernel/cred.js
 *   kernel/pid.js
 *   kernel/sched/core.js
 *   kernel/exec/task.js
 */

'use strict';

export {
    for_each_task,
    get_task,
    scheduler_reset,
    set_task_state,
    task_table,
} from '../sched/core.js';
export {do_fork} from '../fork.js';
export {
    do_exit,
    register_exit_handler,
    unregister_exit_handler,
} from '../exit.js';
export {send_signal} from '../signal.js';
export {
    do_setgid,
    do_setgroups,
    do_setuid,
} from '../cred.js';
export {
    bind_exec_resources,
    prepare_exec_credentials,
} from '../exec/task.js';
