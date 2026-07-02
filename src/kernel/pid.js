/**
 * kernel/pid.js - PID allocation
 *
 * Analogous to kernel/pid.c.
 */

'use strict';

let pid_counter = 0;

export function alloc_pid() {
    return ++pid_counter;
}

export function reset_pid_allocator() {
    pid_counter = 0;
}
