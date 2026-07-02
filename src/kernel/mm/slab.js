// kernel/mm/slab.js
// Analogous to: mm/slab.c, fs/inode.c, kernel/fork.c

import {
    ROOT_UID, ROOT_GID, RING_ROOT, RING_USER,
    S_IFCHR, S_IFDIR, S_IFLNK, S_IFREG,
    TASK_RUNNING,
} from '../include/types.js';
import {create_tty_state} from '../tty/termios.js';
import {byte_length} from '../fs/bytes.js';

// Allocate and initialize an inode.
// Analogous to new_inode(sb) and inode_init_owner().
export function inode_alloc(type_flag, mode, uid, gid, content) {
    const now = Date.now();
    const data = content ?? (type_flag === S_IFDIR ? {} : '');
    return {
        i_mode  : type_flag | (mode & 0o7777),
        i_uid   : uid  ?? ROOT_UID,
        i_gid   : gid  ?? ROOT_GID,
        i_nlink : type_flag === S_IFDIR ? 2 : 1,
        i_size  : type_flag === S_IFREG || type_flag === S_IFLNK
            ? byte_length(data)
            : 0,
        i_atime : now,
        i_mtime : now,
        i_ctime : now,
        i_type  : type_flag === S_IFDIR ? 'dir'
            : type_flag === S_IFLNK ? 'link'
                : type_flag === S_IFCHR ? 'char'
                : 'file',
        i_data  : data,
    };
}

// Allocate and initialize a task structure.
// Analogous to dup_task_struct() and alloc_task_struct_node().
export function task_struct_alloc(comm, uid, gid, cwd, ppid) {
    const default_path =
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const tty = create_tty_state();
    return {
        pid        : 0,
        ppid       : ppid ?? 0,
        pgid       : 0,
        sid        : 0,
        comm,
        executable : null,
        argv       : [comm],
        uid        : uid ?? ROOT_UID,
        gid        : gid ?? ROOT_GID,
        euid       : uid ?? ROOT_UID,
        egid       : gid ?? ROOT_GID,
        suid       : uid ?? ROOT_UID,
        sgid       : gid ?? ROOT_GID,
        groups     : [gid ?? ROOT_GID],
        umask      : 0o022,
        cwd        : cwd ?? '/',
        state      : TASK_RUNNING,
        exit_code  : 0,
        exit_signal: 0,
        stop_reported: false,
        continued_pending: false,
        start_time : Date.now(),
        sig_pending: 0,
        resume_waiters: [],
        envp       : {
            PATH    : default_path,
            HOME    : '/',
            USER    : 'root',
            SHELL   : '/bin/sh',
            TERM    : 'xterm-256color',
            LANG    : 'en_US.UTF-8',
            PWD     : cwd ?? '/',
            HOSTNAME: 'jsnix',
        },
        tty,
        controlling_tty: tty.name,
        fdt        : {
            0: {
                path: '/dev/stdin',
                flags: 'r',
                kind: 'tty',
                readable: true,
                writable: false,
                offset: 0,
                tty,
                refcount: 1,
            },
            1: {
                path: '/dev/stdout',
                flags: 'w',
                kind: 'tty',
                readable: false,
                writable: true,
                offset: 0,
                tty,
                refcount: 1,
            },
            2: {
                path: '/dev/stderr',
                flags: 'w',
                kind: 'tty',
                readable: false,
                writable: true,
                offset: 0,
                tty,
                refcount: 1,
            },
        },
        mm         : null,
        ring       : (uid === ROOT_UID) ? RING_ROOT : RING_USER,
    };
}
