/**
 * init/boot.js - Kernel boot orchestration
 *
 * Analogous to init/main.c. Root file-system data and population live in
 * rootfs/index.js so the boot sequence remains small and easy to audit.
 */

'use strict';

import {
    kernel_init,
    printk,
    reset_kernel_clock,
} from '../kernel/syscall/dispatcher.js';
import {reset_binary_publisher} from '../kernel/exec/program_registry.js';
import {reset_power_state} from '../kernel/power.js';
import {scheduler_reset} from '../kernel/sched/core.js';
import {credentials_reset} from '../kernel/security/credentials.js';
import {vfs_reset} from '../kernel/fs/vfs.js';
import {
    do_basic_setup,
    populate_rootfs,
} from './rootfs/index.js';

const boot_state = {
    started: false,
    pid1: null,
};

export function start_kernel(options = {}) {
    if (boot_state.started) return boot_state.pid1;

    const pid1 = kernel_init();
    printk('init: start_kernel: mm_init done');
    printk('init: start_kernel: vfs_caches_init done (rootfs empty)');
    printk('init: start_kernel: security_init done (user_db empty)');
    do_basic_setup();
    populate_rootfs(options);
    printk(`init: start_kernel: boot complete pid1=${pid1}`);
    boot_state.started = true;
    boot_state.pid1 = pid1;
    return pid1;
}

export function is_kernel_started() {
    return boot_state.started;
}

export function get_boot_state() {
    return {...boot_state};
}

export function reset_kernel() {
    scheduler_reset();
    credentials_reset();
    vfs_reset();
    reset_binary_publisher();
    reset_power_state();
    reset_kernel_clock();
    boot_state.started = false;
    boot_state.pid1 = null;
}
