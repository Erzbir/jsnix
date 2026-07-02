/**
 * kernel/exec/execve.js - Program lookup and process execution
 *
 * Analogous to:
 *   fs/exec.c           - do_execve and search_binary_handler
 *   fs/binfmt_script.c  - script image loading
 *   fs/binfmt_elf.c     - executable image loading
 *
 * An executable is a regular VFS file with execute permission. JSNix executable
 * images are loaded directly. Script files starting with "#!" are
 * rewritten to interpreter argv and executed through the interpreter.
 * Command lookup and execution always start from the executable file.
 */

'use strict';

import {ksyms} from '../ksyms.js';
import {
    AT_EACCESS,
    AT_FDCWD,
    EACCES,
    ELOOP,
    ENOENT,
    ENOEXEC,
    MAY_EXEC,
} from '../include/types.js';
import {strerror} from '../abi/libc.js';
import {
    compile_program_image,
    is_async_program_source,
    parse_program_image,
} from './binfmt_js.js';
import {make_proc_ctx} from './program_context.js';
import {wait_for_pipe_eof} from '../fs/file.js';
import {
    find_registered_program,
    get_registered_binary_path,
    list_registered_program_names,
} from './program_registry.js';

const BINPRM_MAX_RECURSION = 8;
const SHELL_EXECUTABLES = new Set([
    '/bin/bash',
    '/bin/dash',
    '/bin/sh',
    '/usr/bin/bash',
    '/usr/bin/dash',
    '/usr/bin/sh',
]);

function shell_script_body(content) {
    const text = String(content ?? '');
    const first_newline = text.indexOf('\n');
    return text.startsWith('#!')
        ? first_newline < 0 ? '' : text.slice(first_newline + 1)
        : text;
}

function shell_script_needs_async(pid, content, depth) {
    const reserved = new Set([
        'do',
        'done',
        'else',
        'fi',
        'for',
        'if',
        'then',
        'while',
    ]);
    const body = shell_script_body(content);
    for (const statement of body.split(/[;\r\n]+/)) {
        const line = statement.trim();
        if (!line || line.startsWith('#')) continue;
        const cmd = line.split(/\s+/)[0];
        if (!cmd || reserved.has(cmd)) continue;
        if (executable_needs_async(pid, cmd, depth + 1)) return true;
    }
    return false;
}

function task_path(pid) {
    return ksyms.get_task(pid)?.envp?.PATH ??
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

function executable_candidates(pid, command) {
    const task = ksyms.get_task(pid);
    const cwd = task?.cwd ?? '/';
    if (command.includes('/'))
        return [ksyms.path_resolve(command, cwd)];
    return task_path(pid)
        .split(':')
        .map(directory =>
            ksyms.path_resolve(`${directory || '.'}/${command}`, cwd));
}

export function resolve_executable(pid, command) {
    let denied_path = null;
    for (const path of executable_candidates(pid, command)) {
        const stat = ksyms.syscall(pid, ksyms.nr.__NR_stat, path);
        if (stat.err) {
            if (stat.err === -EACCES) denied_path ??= path;
            continue;
        }
        if (stat.val.type !== 'file') {
            denied_path ??= path;
            continue;
        }
        const access = ksyms.syscall(
            pid,
            ksyms.nr.__NR_faccessat2,
            AT_FDCWD,
            path,
            MAY_EXEC,
            AT_EACCESS,
        );
        if (access.err) {
            denied_path ??= path;
            continue;
        }
        return {path, inode: ksyms.path_lookup(path)};
    }
    return denied_path
        ? {err: -EACCES, path: denied_path}
        : {err: -ENOENT};
}

export function list_binaries(pid = null) {
    if (pid === null) return list_registered_program_names();

    const names = new Set();
    const task = ksyms.get_task(pid);
    const cwd = task?.cwd ?? '/';
    for (const directory of task_path(pid).split(':')) {
        const path = ksyms.path_resolve(directory || '.', cwd);
        const entries = ksyms.syscall(pid, ksyms.nr.__NR_getdents, path);
        if (entries.err) continue;
        for (const name of entries.val) {
            const resolved = resolve_executable(pid, `${path}/${name}`);
            if (!resolved.err) names.add(name);
        }
    }
    return [...names];
}

export function get_binary_path(name, pid = null) {
    if (pid !== null) {
        const resolved = resolve_executable(pid, name);
        return resolved.err ? null : resolved.path;
    }
    return get_registered_binary_path(name);
}

export function executable_needs_async(pid, command, depth = 0) {
    if (depth >= BINPRM_MAX_RECURSION) return false;

    const resolved = resolve_executable(pid, command);
    if (resolved.err) return false;

    const script = parse_script_header(resolved.inode.i_data);
    if (script) {
        if (!script.interpreter.startsWith('/')) return false;
        if (SHELL_EXECUTABLES.has(script.interpreter))
            return shell_script_needs_async(pid, resolved.inode.i_data, depth);
        return executable_needs_async(pid, script.interpreter, depth + 1);
    }

    try {
        const image = parse_program_image(resolved.inode.i_data);
        return is_async_program_source(image.source);
    } catch {
        return false;
    }
}

function failed_exec(command, path, errno) {
    const message = errno === EACCES
        ? 'Permission denied'
        : strerror(errno);
    return {
        stdout_buf: [],
        stderr_buf: [{
            text: `${command}: ${path ? `${path}: ` : ''}${message}`,
            tone: 'error',
        }],
        exit_code: errno === ENOENT ? 127 : 126,
        errno,
        path,
    };
}

function configure_exec_fds(pid, options = {}) {
    const mappings = Object.entries(options.fd_map ?? {})
        .map(([target, source]) => [Number(target), Number(source)]);
    for (const [target, source] of mappings) {
        const result = ksyms.syscall(
            pid, ksyms.nr.__NR_dup2, source, target);
        if (result.err) return result;
    }

    const preserved = new Set(mappings.map(([target]) => target));
    for (const fd of new Set(options.close_fds ?? [])) {
        if (preserved.has(Number(fd))) continue;
        const task = ksyms.get_task(pid);
        if (task?.fdt && Object.hasOwn(task.fdt, fd))
            ksyms.syscall(pid, ksyms.nr.__NR_close, Number(fd));
    }
    return {val: 0};
}

function configure_exec_process(pid, options = {}) {
    if (options.process_group === undefined) return {val: 0};
    const pgid = options.process_group === 'new'
        ? 0
        : Number(options.process_group);
    return ksyms.syscall(pid, ksyms.nr.__NR_setpgid, 0, pgid);
}

function preserved_exec_fds(options = {}) {
    return options.preserve_fds ??
        Object.keys(options.fd_map ?? {}).map(Number);
}

function reap_finished_child(parent_pid, child_pid) {
    if (ksyms.get_task(child_pid)?.state !== ksyms.types.TASK_ZOMBIE) return;
    ksyms.syscall(
        parent_pid,
        ksyms.nr.__NR_wait4,
        child_pid,
        ksyms.types.WNOHANG,
    );
}

function routed_output_buffer(pid, fd) {
    const output = [];
    return new Proxy(output, {
        get(target, property, receiver) {
            if (property !== 'push')
                return Reflect.get(target, property, receiver);
            return (...items) => {
                for (const item of items) {
                    const file = ksyms.get_task(pid)?.fdt?.[fd];
                    const routed = file &&
                        file.kind !== 'stdio' && file.kind !== 'tty';
                    if (!routed || item?.type === 'control') {
                        Array.prototype.push.call(target, item);
                        continue;
                    }
                    const value = typeof item === 'object' && item !== null
                        ? String(item.text ?? '')
                        : String(item ?? '');
                    ksyms.syscall(
                        pid, ksyms.nr.__NR_write, fd, `${value}\n`);
                }
                return target.length;
            };
        },
    });
}

function read_exec_stdin(pid, fallback, preserve_fds = []) {
    if (!new Set(preserve_fds).has(0)) return fallback ?? '';
    const result = ksyms.syscall(pid, ksyms.nr.__NR_read, 0);
    return result.err ? '' : result.val;
}

async function read_exec_stdin_async(pid, fallback, preserve_fds = []) {
    if (!new Set(preserve_fds).has(0)) return fallback ?? '';
    const file = ksyms.get_task(pid)?.fdt?.[0];
    if (file?.kind === 'pipe') {
        ksyms.set_task_state(pid, ksyms.types.TASK_SLEEPING);
        await wait_for_pipe_eof(file.pipe);
        if (ksyms.get_task(pid)?.state !== ksyms.types.TASK_ZOMBIE)
            ksyms.set_task_state(pid, ksyms.types.TASK_RUNNING);
    }
    return read_exec_stdin(pid, fallback, preserve_fds);
}

function is_thenable(value) {
    return value && typeof value.then === 'function';
}

function normalize_exit_code(value) {
    const code = value ?? 0;
    return Number.isInteger(code) ? code : Number(code) || 0;
}

function parse_script_header(content) {
    const text = String(content ?? '');
    if (!text.startsWith('#!')) return null;
    const line_end = text.indexOf('\n');
    const line = (line_end < 0 ? text : text.slice(0, line_end))
        .slice(2)
        .trim();
    if (!line) return null;

    const match = line.match(/^(\S+)(?:\s+(.*))?$/);
    if (!match) return null;
    return {
        interpreter: match[1],
        argument: match[2]?.trim() || null,
    };
}

function script_execve(
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    command,
    script_path,
    header,
    argv,
    stdin_data,
    depth,
    options,
) {
    if (depth >= BINPRM_MAX_RECURSION)
        return failed_exec(command, script_path, ELOOP);
    if (!header.interpreter.startsWith('/'))
        return failed_exec(command, header.interpreter, ENOENT);

    const next_argv = [
        header.interpreter,
        ...(header.argument ? [header.argument] : []),
        script_path,
        ...argv.slice(1),
    ];
    const result = do_execve(
        parent_pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        next_argv,
        stdin_data,
        depth + 1,
        options,
    );
    if (!result) return failed_exec(command, header.interpreter, ENOENT);
    result.script = script_path;
    return result;
}

function script_execve_async(
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    command,
    script_path,
    header,
    argv,
    stdin_data,
    depth,
    options,
) {
    if (depth >= BINPRM_MAX_RECURSION)
        return Promise.resolve(failed_exec(command, script_path, ELOOP));
    if (!header.interpreter.startsWith('/'))
        return Promise.resolve(failed_exec(command, header.interpreter, ENOENT));

    const next_argv = [
        header.interpreter,
        ...(header.argument ? [header.argument] : []),
        script_path,
        ...argv.slice(1),
    ];
    const result = do_execve_async(
        parent_pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        next_argv,
        stdin_data,
        depth + 1,
        options,
    );
    const wrapped = Promise.resolve(result).then(value => {
        if (!value) return failed_exec(command, header.interpreter, ENOENT);
        value.script = script_path;
        return value;
    });
    wrapped.pid = result?.pid;
    return wrapped;
}

function run_program_image({
    pid,
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    resolved,
    argv,
    stdin_data,
    depth,
    exit_on_return,
    preserve_fds = [],
}) {
    const command = argv[0];
    let image;
    let program;
    try {
        image = parse_program_image(resolved.inode.i_data);
        program = compile_program_image(
            image,
            find_registered_program(resolved.path, image.source),
        );
    } catch (error) {
        if (exit_on_return && pid !== parent_pid)
            ksyms.syscall(pid, ksyms.nr.__NR_exit, 126);
        return failed_exec(command, resolved.path, error.errno ?? ENOEXEC);
    }

    const comm = resolved.path.split('/').pop() || command;
    const stdout_buf = routed_output_buffer(pid, 1);
    const stderr_buf = routed_output_buffer(pid, 2);
    ksyms.bind_exec_resources(pid, {
        comm,
        executable: resolved.path,
        argv: [resolved.path, ...argv.slice(1)],
        stdin: stdin_data ?? '',
        stdout: stdout_buf,
        stderr: stderr_buf,
        format: image.header.format,
        image_size: image.size,
        preserve_fds,
    });
    ksyms.prepare_exec_credentials(pid, parent_pid, resolved.inode);
    stdin_data = read_exec_stdin(pid, stdin_data, preserve_fds);
    const ctx = make_proc_ctx({
        pid,
        argv: [resolved.path, ...argv.slice(1)],
        stdin_data,
        stdout_buf,
        stderr_buf,
        list_binaries: () => list_binaries(pid),
        get_binary_path: name => get_binary_path(name, pid),
        run_child: (child_argv, input, libc) => do_execve(
            pid,
            libc.getuid(),
            libc.getgid(),
            libc.getcwd(),
            child_argv,
            input,
            depth + 1,
        ),
    });
    let exit_code = 0;

    try {
        exit_code = program(ctx) ?? 0;
        if (is_thenable(exit_code)) {
            ctx.perror(`${comm}: asynchronous program requires async exec`);
            exit_code = 1;
        } else {
            exit_code = normalize_exit_code(exit_code);
        }
    } catch (error) {
        ctx.perror(`${comm}: ${error.message}`);
        exit_code = 1;
    }

    return finish_program_image({
        pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        resolved,
        stdout_buf,
        stderr_buf,
        exit_code,
        exit_on_return,
    });
}

async function run_program_image_async({
    pid,
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    resolved,
    argv,
    stdin_data,
    depth,
    exit_on_return,
    preserve_fds = [],
}) {
    const command = argv[0];
    let image;
    let program;
    try {
        image = parse_program_image(resolved.inode.i_data);
        program = compile_program_image(
            image,
            find_registered_program(resolved.path, image.source),
        );
    } catch (error) {
        if (exit_on_return && pid !== parent_pid)
            ksyms.syscall(pid, ksyms.nr.__NR_exit, 126);
        return failed_exec(command, resolved.path, error.errno ?? ENOEXEC);
    }

    const comm = resolved.path.split('/').pop() || command;
    const stdout_buf = routed_output_buffer(pid, 1);
    const stderr_buf = routed_output_buffer(pid, 2);
    ksyms.bind_exec_resources(pid, {
        comm,
        executable: resolved.path,
        argv: [resolved.path, ...argv.slice(1)],
        stdin: stdin_data ?? '',
        stdout: stdout_buf,
        stderr: stderr_buf,
        format: image.header.format,
        image_size: image.size,
        preserve_fds,
    });
    ksyms.prepare_exec_credentials(pid, parent_pid, resolved.inode);
    if (new Set(preserve_fds).has(0))
        stdin_data = await read_exec_stdin_async(pid, stdin_data, preserve_fds);
    const ctx = make_proc_ctx({
        pid,
        argv: [resolved.path, ...argv.slice(1)],
        stdin_data,
        stdout_buf,
        stderr_buf,
        list_binaries: () => list_binaries(pid),
        get_binary_path: name => get_binary_path(name, pid),
        run_child: (child_argv, input, libc) => do_execve_async(
            pid,
            libc.getuid(),
            libc.getgid(),
            libc.getcwd(),
            child_argv,
            input,
            depth + 1,
        ),
    });
    let exit_code = 0;

    try {
        exit_code = normalize_exit_code(await program(ctx));
    } catch (error) {
        ctx.perror(`${comm}: ${error.message}`);
        exit_code = 1;
    }

    const task = ksyms.get_task(pid);
    if (task?.state === ksyms.types.TASK_ZOMBIE)
        exit_code = task.exit_code;

    return finish_program_image({
        pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        resolved,
        stdout_buf,
        stderr_buf,
        exit_code,
        exit_on_return,
    });
}

function finish_program_image({
    pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    resolved,
    stdout_buf,
    stderr_buf,
    exit_code,
    exit_on_return,
}) {
    const shell_session = stdout_buf.find(item =>
        item?.type === 'control' &&
        item.action === 'shell-session');
    const editor_session = stdout_buf.find(item =>
        item?.type === 'control' &&
        item.action === 'editor-session');
    const is_shell = SHELL_EXECUTABLES.has(resolved.path);
    if (shell_session && is_shell && exit_code === 0) {
        const task = ksyms.get_task(pid);
        shell_session.pid = pid;
        shell_session.uid = task?.uid;
        shell_session.gid = task?.gid;
        shell_session.euid = task?.euid;
        shell_session.egid = task?.egid;
    } else if (editor_session && exit_code === 0) {
        const task = ksyms.get_task(pid);
        editor_session.pid = pid;
        editor_session.uid = task?.uid;
        editor_session.gid = task?.gid;
        editor_session.euid = task?.euid;
        editor_session.egid = task?.egid;
    } else if (exit_on_return &&
        ksyms.get_task(pid)?.state !== ksyms.types.TASK_ZOMBIE) {
        ksyms.syscall(pid, ksyms.nr.__NR_exit, exit_code);
    }

    const snapshot = ksyms.get_task(pid);
    return {
        pid,
        executable: resolved.path,
        stdout_buf,
        stderr_buf,
        exit_code,
        cwd: snapshot?.cwd ?? parent_cwd,
        uid: snapshot?.uid ?? parent_uid,
        gid: snapshot?.gid ?? parent_gid,
        euid: snapshot?.euid ?? parent_uid,
        egid: snapshot?.egid ?? parent_gid,
    };
}

// Resolve an executable file, create a child process, bind its resources,
// load the JavaScript image, run its entry point, and terminate the process.
export function do_execve(
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    argv,
    stdin_data,
    depth = 0,
    options = {},
) {
    if (!argv.length) return null;
    const parent = ksyms.get_task(parent_pid);
    if (parent) {
        parent_uid = parent.uid;
        parent_gid = parent.gid;
        parent_cwd = parent.cwd;
    }
    const command = argv[0];
    const resolved = resolve_executable(parent_pid, command);
    if (resolved.err) {
        if (resolved.err === -ENOENT) return null;
        return failed_exec(command, resolved.path, -resolved.err);
    }

    const script = parse_script_header(resolved.inode.i_data);
    if (script)
        return script_execve(
            parent_pid,
            parent_uid,
            parent_gid,
            parent_cwd,
            command,
            resolved.path,
            script,
            argv,
            stdin_data,
            depth,
            options,
        );

    const comm = resolved.path.split('/').pop() || command;
    const child_pid = ksyms.kernel_spawn(
        comm,
        parent_uid,
        parent_gid,
        parent_cwd,
        parent_pid,
    );
    const configured = configure_exec_fds(child_pid, options);
    if (configured.err) {
        ksyms.syscall(child_pid, ksyms.nr.__NR_exit, 126);
        return failed_exec(command, resolved.path, -configured.err);
    }
    const grouped = configure_exec_process(child_pid, options);
    if (grouped.err) {
        ksyms.syscall(child_pid, ksyms.nr.__NR_exit, 126);
        return failed_exec(command, resolved.path, -grouped.err);
    }
    const result = run_program_image({
        pid: child_pid,
        parent_pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        resolved,
        argv,
        stdin_data,
        depth,
        exit_on_return: true,
        preserve_fds: preserved_exec_fds(options),
    });
    reap_finished_child(parent_pid, child_pid);
    return result;
}

// Async variant used by foreground waits and background jobs. It keeps the
// same fork + exec model as do_execve(), but allows a JavaScript executable to
// yield by returning a Promise.
export function do_execve_async(
    parent_pid,
    parent_uid,
    parent_gid,
    parent_cwd,
    argv,
    stdin_data,
    depth = 0,
    options = {},
) {
    if (!argv.length) return Promise.resolve(null);
    const parent = ksyms.get_task(parent_pid);
    if (parent) {
        parent_uid = parent.uid;
        parent_gid = parent.gid;
        parent_cwd = parent.cwd;
    }
    const command = argv[0];
    const resolved = resolve_executable(parent_pid, command);
    if (resolved.err) {
        if (resolved.err === -ENOENT) return Promise.resolve(null);
        return Promise.resolve(failed_exec(command, resolved.path, -resolved.err));
    }

    const script = parse_script_header(resolved.inode.i_data);
    if (script)
        return script_execve_async(
            parent_pid,
            parent_uid,
            parent_gid,
            parent_cwd,
            command,
            resolved.path,
            script,
            argv,
            stdin_data,
            depth,
            options,
        );

    const comm = resolved.path.split('/').pop() || command;
    const child_pid = ksyms.kernel_spawn(
        comm,
        parent_uid,
        parent_gid,
        parent_cwd,
        parent_pid,
    );
    const configured = configure_exec_fds(child_pid, options);
    if (configured.err) {
        ksyms.syscall(child_pid, ksyms.nr.__NR_exit, 126);
        return Promise.resolve(
            failed_exec(command, resolved.path, -configured.err));
    }
    const grouped = configure_exec_process(child_pid, options);
    if (grouped.err) {
        ksyms.syscall(child_pid, ksyms.nr.__NR_exit, 126);
        return Promise.resolve(
            failed_exec(command, resolved.path, -grouped.err));
    }
    const execution = run_program_image_async({
        pid: child_pid,
        parent_pid,
        parent_uid,
        parent_gid,
        parent_cwd,
        resolved,
        argv,
        stdin_data,
        depth,
        exit_on_return: true,
        preserve_fds: preserved_exec_fds(options),
    });
    const promise = Promise.resolve(execution).then(result => {
        reap_finished_child(parent_pid, child_pid);
        return result;
    });
    promise.pid = child_pid;
    return promise;
}

// execve into the current task. This models the shell "exec" builtin:
// no new PID is allocated, and a successful program return terminates the
// task that used to be the shell.
export function do_execve_in_place(pid, argv, stdin_data, depth = 0) {
    if (!argv.length) return null;
    const task = ksyms.get_task(pid);
    if (!task) return null;

    const command = argv[0];
    const resolved = resolve_executable(pid, command);
    if (resolved.err) {
        if (resolved.err === -ENOENT) return null;
        return failed_exec(command, resolved.path, -resolved.err);
    }

    const script = parse_script_header(resolved.inode.i_data);
    if (script) {
        if (depth >= BINPRM_MAX_RECURSION)
            return failed_exec(command, resolved.path, ELOOP);
        if (!script.interpreter.startsWith('/'))
            return failed_exec(command, script.interpreter, ENOENT);
        return do_execve_in_place(
            pid,
            [
                script.interpreter,
                ...(script.argument ? [script.argument] : []),
                resolved.path,
                ...argv.slice(1),
            ],
            stdin_data,
            depth + 1,
        );
    }

    return run_program_image({
        pid,
        parent_pid: pid,
        parent_uid: task.uid,
        parent_gid: task.gid,
        parent_cwd: task.cwd,
        resolved,
        argv,
        stdin_data,
        depth,
        exit_on_return: true,
    });
}
