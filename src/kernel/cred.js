/**
 * kernel/cred.js - Process credentials
 *
 * Analogous to kernel/cred.c.
 */

'use strict';

import {
    EPERM,
    RING_ROOT,
    RING_USER,
    ROOT_UID,
} from './include/types.js';

export function do_setuid(task, new_uid) {
    if (task.euid === ROOT_UID) {
        task.uid = new_uid;
        task.euid = new_uid;
        task.suid = new_uid;
    } else if (new_uid === task.uid || new_uid === task.suid) {
        task.euid = new_uid;
    } else {
        return -EPERM;
    }
    task.ring = task.euid === ROOT_UID ? RING_ROOT : RING_USER;
    return 0;
}

export function do_setgid(task, new_gid) {
    if (task.euid === ROOT_UID) {
        task.gid = new_gid;
        task.egid = new_gid;
        task.sgid = new_gid;
    } else if (new_gid === task.gid || new_gid === task.sgid) {
        task.egid = new_gid;
    } else {
        return -EPERM;
    }
    return 0;
}

export function do_setgroups(task, groups) {
    if (task.euid !== ROOT_UID) return -EPERM;
    task.groups = [...new Set(groups)];
    return 0;
}
