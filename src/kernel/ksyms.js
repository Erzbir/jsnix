/**
 * kernel/include/ksyms.js - Kernel symbol table (public API)
 *
 * Analogous to:
 *   include/linux/export.h  - EXPORT_SYMBOL / EXPORT_SYMBOL_GPL
 *   kernel/kallsyms.c       - symbol lookup
 *
 * This module defines the kernel and user-space boundary.
 * User-space code should access kernel services through this
 * interface instead of importing kernel internals directly.
 *
 * The `ksyms` object is frozen so no user-space code can
 * monkey-patch kernel internals.
 */

'use strict';

// Exported kernel symbols.
// Analogous to EXPORT_SYMBOL and EXPORT_SYMBOL_GPL.

import * as NR from './include/syscall_nr.js';
import * as T from './include/types.js';
import {
    kernel_boot_time,
    do_syscall,
} from './syscall/dispatcher.js';
import {do_fork} from './fork.js';
import {
    for_each_task,
    get_task,
    set_task_state,
} from './sched/core.js';
import {
    bind_exec_resources,
    prepare_exec_credentials,
} from './exec/task.js';
import {
    register_exit_handler,
    unregister_exit_handler,
} from './exit.js';
import {kernel_power_state} from './power.js';
import {path_lookup, path_lstat, path_resolve} from './fs/vfs.js';
import {
    getgrgid,
    getgrnam,
    getpwnam,
    getpwuid,
    gid_to_groupname,
    list_groups,
    list_users,
    uid_to_home,
    uid_to_username,
} from './security/credentials.js';

export const ksyms = Object.freeze({

    // Build information.
    UTS_RELEASE : '0.1.0-jsnix',
    UTS_MACHINE : 'js-x64',
    get boot_time() { return kernel_boot_time; },
    get jiffies()   { return Date.now(); },

    // System call entry point.
    // The PID identifies the calling task.
    syscall: (pid, nr, ...args) => do_syscall(pid, nr, args),

    // Process lifecycle.
    kernel_spawn : (comm, uid, gid, cwd, ppid) =>
        do_fork(comm, uid, gid, cwd, ppid),

    get_task,
    for_each_task,
    bind_exec_resources,
    prepare_exec_credentials,
    set_task_state,
    power_state: kernel_power_state,
    register_exit_handler,
    unregister_exit_handler,
    getpwnam,
    getpwuid,
    getgrnam,
    getgrgid,
    list_users,
    list_groups,
    uid_to_home,
    uid_to_username,
    gid_to_groupname,

    // VFS path helpers.
    // These read-only helpers are used for path arithmetic,
    // tab completion, and prompt rendering.
    path_resolve,
    path_lookup,
    path_lstat,

    // System call numbers.
    nr: Object.freeze({ ...NR }),

    // Type constants.
    types: Object.freeze({ ...T }),
});
