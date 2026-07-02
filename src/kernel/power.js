/**
 * kernel/power.js - Simulated kernel power state
 *
 * Analogous to kernel/reboot.c. User-space requests a reboot or power-off
 * through a system call; front-end applications decide how to present or
 * restart their TTY instances.
 */

'use strict';

import {EINVAL} from './include/types.js';

const RUNNING_STATE = Object.freeze({
    state: 'running',
    action: null,
    requested_at: null,
    requested_by: null,
    reason: null,
});

let power_state = {...RUNNING_STATE};

export function kernel_power_state() {
    return {...power_state};
}

export function reset_power_state() {
    power_state = {...RUNNING_STATE};
}

export function kernel_power_request(action, pid) {
    const normalized = {
        reboot: 'restart',
        restart: 'restart',
        poweroff: 'poweroff',
        'power-off': 'poweroff',
        halt: 'halt',
    }[String(action ?? 'restart')];
    if (!normalized) return -EINVAL;

    power_state = {
        state: normalized === 'restart' ? 'rebooting' : 'stopping',
        action: normalized,
        requested_at: Date.now(),
        requested_by: pid ?? null,
        reason: null,
    };
    return 0;
}

export function kernel_panic(reason, pid) {
    power_state = {
        state: 'panic',
        action: 'panic',
        requested_at: Date.now(),
        requested_by: pid ?? null,
        reason: String(reason ?? 'kernel panic'),
    };
}
