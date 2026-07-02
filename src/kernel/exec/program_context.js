/**
 * kernel/exec/program_context.js - JavaScript executable process context
 *
 * This builds the object passed to a simulated executable's entry function.
 * It is separate from execve.js so PATH lookup, image loading, and runtime ABI
 * helpers do not accumulate in one module.
 */

'use strict';

import {ksyms} from '../ksyms.js';
import {make_libc} from '../abi/libc.js';
import {
    TASK_RUNNING,
    TASK_SLEEPING,
    TASK_ZOMBIE,
} from '../include/types.js';

function task_snapshot(task) {
    return {
        pid: task.pid,
        ppid: task.ppid,
        pgid: task.pgid,
        sid: task.sid,
        comm: task.comm,
        executable: task.executable,
        argv: [...(task.argv ?? [])],
        uid: task.uid,
        gid: task.gid,
        euid: task.euid,
        egid: task.egid,
        groups: [...(task.groups ?? [])],
        cwd: task.cwd,
        state: task.state,
        exit_code: task.exit_code,
        start_time: task.start_time,
        fdt: Object.fromEntries(
            Object.entries(task.fdt ?? {}).map(([fd, entry]) => [
                fd,
                {
                    path: entry.path,
                    flags: entry.flags,
                    kind: entry.kind,
                    readable: Boolean(entry.readable),
                    writable: Boolean(entry.writable),
                },
            ])
        ),
        mm: task.mm ? {...task.mm} : null,
    };
}

export function make_proc_ctx({
    pid,
    argv,
    stdin_data,
    stdout_buf,
    stderr_buf,
    list_binaries,
    get_binary_path,
    run_child,
}) {
    const libc = make_libc(pid);
    const args = argv.slice(1);
    const _puts = (text, tone) =>
        stdout_buf.push({text: String(text), tone: tone ?? 'normal'});
    const _segments = segments => {
        const normalized = segments.map(segment => ({
            text: String(segment?.text ?? ''),
            role: segment?.role ?? 'normal',
        }));
        stdout_buf.push({
            text: normalized.map(segment => segment.text).join(''),
            tone: 'normal',
            segments: normalized,
        });
    };
    let sleep_id = 0;

    return Object.freeze({
        argv: [...argv],
        args,
        stdin: stdin_data ?? '',
        stdout_buf,
        stderr_buf,

        puts: (...values) => _puts(values.join(' '), 'normal'),
        printf: (...values) => _puts(values.join(' '), 'normal'),
        perror: (...values) =>
            stderr_buf.push({text: values.join(' '), tone: 'error'}),
        info: (...values) => _puts(values.join(' '), 'info'),
        success: (...values) => _puts(values.join(' '), 'success'),
        warn: (...values) => _puts(values.join(' '), 'warning'),
        dim: (...values) => _puts(values.join(' '), 'muted'),
        printSegments: segments => _segments(segments),
        special: (key, data = {}) =>
            stdout_buf.push({
                type: 'control',
                action: key,
                ...data,
            }),

        ...libc,

        list_procs() {
            const output = [];
            ksyms.for_each_task(task => output.push(task_snapshot(task)));
            return output;
        },
        get_username: ksyms.uid_to_username,
        get_groupname: ksyms.gid_to_groupname,
        list_binaries,
        get_binary_path,
        sleep(ms) {
            const duration = Math.max(0, Number(ms) || 0);
            const key = `proc_sleep_${pid}_${++sleep_id}`;
            ksyms.set_task_state(pid, TASK_SLEEPING);
            return new Promise(resolve => {
                const finish = ok => {
                    clearTimeout(timer);
                    ksyms.unregister_exit_handler(pid, key);
                    const task = ksyms.get_task(pid);
                    if (ok && task && task.state !== TASK_ZOMBIE)
                        ksyms.set_task_state(pid, TASK_RUNNING);
                    resolve(Boolean(ok));
                };
                const timer = setTimeout(() => {
                    const task = ksyms.get_task(pid);
                    if (task?.state === ksyms.types.TASK_STOPPED) {
                        task.resume_waiters.push(() => finish(true));
                        return;
                    }
                    finish(true);
                }, duration);
                timer.unref?.();
                ksyms.register_exit_handler(pid, key, () => finish(false));
            });
        },
        run(child_argv, input = '') {
            return run_child(child_argv, input, libc);
        },
    });
}
