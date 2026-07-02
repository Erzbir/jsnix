/**
 * kernel/fs/file.js - Open file description lifetime helpers
 *
 * A task fd table stores references to open file descriptions. dup() and
 * fork() add references to the same description, so the shared offset and
 * status flags survive while closing one descriptor only drops one reference.
 */

'use strict';

export function file_get(file) {
    if (!file) return null;
    file.refcount = Math.max(0, Number(file.refcount) || 0) + 1;
    return file;
}

export function file_put(file) {
    if (!file) return 0;
    file.refcount = Math.max(0, (Number(file.refcount) || 1) - 1);
    if (file.refcount !== 0) return file.refcount;

    if (file.kind === 'pipe' && file.pipe) {
        if (file.readable)
            file.pipe.readers = Math.max(0, (file.pipe.readers ?? 1) - 1);
        if (file.writable)
            file.pipe.writers = Math.max(0, (file.pipe.writers ?? 1) - 1);
        if (file.pipe.writers === 0) {
            for (const resolve of file.pipe.eof_waiters?.splice(0) ?? [])
                resolve();
        }
    }
    return 0;
}

export function wait_for_pipe_eof(pipe) {
    if (!pipe || pipe.writers === 0) return Promise.resolve();
    return new Promise(resolve => {
        pipe.eof_waiters ??= [];
        pipe.eof_waiters.push(resolve);
    });
}

export function clone_fdtable(fdt = {}) {
    return Object.fromEntries(
        Object.entries(fdt).map(([fd, file]) => [fd, file_get(file)]),
    );
}

export function close_task_fd(task, fd) {
    if (!task?.fdt || !Object.hasOwn(task.fdt, fd)) return false;
    const file = task.fdt[fd];
    delete task.fdt[fd];
    file_put(file);
    return true;
}

export function install_task_fd(task, fd, file) {
    if (Object.hasOwn(task.fdt, fd)) close_task_fd(task, fd);
    task.fdt[fd] = file;
    return fd;
}

export function release_task_files(task) {
    if (!task?.fdt) return;
    for (const fd of Object.keys(task.fdt)) close_task_fd(task, fd);
}
