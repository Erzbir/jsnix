/**
 * usr/shell/bash.js - Interactive shell (bash analogue)
 *
 * Analogous to:
 *   bash/execute_cmd.c  - execute_command, execute_pipeline
 *   bash/parse.y        - shell parser
 *   bash/builtins/      - cd, export, help, su, history
 *   drivers/tty/tty_io.c - TTY line discipline integration
 *
 * Each Bash instance owns a kernel task. When that task exits,
 * the TTY driver receives an exit callback and starts a new session.
 *
 * Shell built-ins run in the shell task because they modify its
 * working directory, environment, credentials, or lifecycle.
 * Other commands run through do_execve().
 */

'use strict';

import {ksyms} from '../../kernel/ksyms.js';
import {
    do_execve,
    do_execve_async,
    do_execve_in_place,
    executable_needs_async,
    get_binary_path,
} from '../../kernel/exec/execve.js';
import {
    ENOEXEC,
    EPERM,
    INIT_PID,
    ROOT_UID,
    SIGCONT,
    SIGSTOP,
    SIGTERM,
    TASK_ZOMBIE,
} from '../../kernel/include/types.js';
import {
    SHELL_BUILTIN_HELP,
    SHELL_BUILTINS,
    is_shell_reserved_word,
} from './builtins.js';
import {
    parse_command_list,
    parse_pipeline,
    tokenize,
} from './parser.js';
import {bash_job_control_methods} from './jobs.js';

export {bash_history} from './history.js';
export {bash_tab_complete} from './completion.js';

export class Bash {
    constructor(uid, gid, options = {}) {
        const parent_pid = options.ppid ?? INIT_PID;
        this._pid = ksyms.kernel_spawn(
            'bash',
            uid,
            gid,
            options.cwd ?? ksyms.uid_to_home(uid) ?? '/',
            parent_pid,
        );
        if (parent_pid === INIT_PID) {
            ksyms.syscall(
                this._pid, ksyms.nr.__NR_setpgid, 0, 0);
            const pgid = ksyms.syscall(
                this._pid, ksyms.nr.__NR_getpgid, 0).val;
            ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_ioctl,
                0,
                ksyms.types.TIOCSPGRP,
                pgid,
            );
        }
        this._session_stack = [];
        this.argv0 = options.argv0 ?? 'bash';
        this.positional = [...(options.args ?? [])];
        this.history = options.history ?? [];
        this.history_enabled =
            options.history_enabled ??
            true;
        this.last_exit_status = 0;
        this.jobs = options.jobs ?? [];
        this.job_seq = options.job_seq ??
            this.jobs.reduce((max, job) => Math.max(max, job.id ?? 0), 0);
        this.on_job_output =
            options.on_job_output ??
            null;
        this.foreground_pid = null;
        this.foreground_pgid = null;
        this.aliases = new Map();
        this._exit_handler_key = `bash_jobs_${this.pid}`;
        ksyms.register_exit_handler(this.pid, this._exit_handler_key, () => {
            this._terminate_all_jobs(1);
        });
    }

    get pid() {
        return this._pid;
    }

    get _task() {
        return ksyms.get_task(this._pid);
    }

    get uid() {
        return this._task?.uid ?? ROOT_UID;
    }

    get gid() {
        return this._task?.gid ?? 0;
    }

    get cwd() {
        return this._task?.cwd ?? '/';
    }

    get home() {
        return ksyms.uid_to_home(this.uid);
    }

    get username() {
        return ksyms.uid_to_username(this.uid);
    }

    get envp() {
        return this._task?.envp ?? {};
    }

    get is_alive() {
        const t = this._task;
        return t !== undefined && t.state !== TASK_ZOMBIE;
    }

    _tokenize(line) {
        return tokenize(line, token => this._expand(token));
    }

    _replace_command_substitutions(token, values) {
        let output = '';
        for (let index = 0; index < token.length; index++) {
            if (token[index] !== '$' || token[index + 1] !== '(') {
                output += token[index];
                continue;
            }

            let depth = 1;
            let quote = null;
            let escaped = false;
            let end = -1;
            for (let cursor = index + 2; cursor < token.length; cursor++) {
                const char = token[cursor];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (quote) {
                    if (char === quote) quote = null;
                    continue;
                }
                if (char === '\'' || char === '"') {
                    quote = char;
                    continue;
                }
                if (char === '(') depth++;
                else if (char === ')' && --depth === 0) {
                    end = cursor;
                    break;
                }
            }
            if (end < 0) throw new Error('unexpected EOF while looking for matching `)`');

            const command = token.slice(index + 2, end);
            const marker = `\uE100${values.length}\uE101`;
            values.push(this._run_command_substitution(command));
            output += marker;
            index = end;
        }
        return output;
    }

    _run_command_substitution(command) {
        const child = this._fork_subshell();
        try {
            const output = child.execute(command, {record_history: false})
                .filter(item => item?.tone !== 'error' && item?.type !== 'control')
                .map(item => item.text ?? '')
                .join('\n');
            this.last_exit_status = child.last_exit_status;
            return output.replace(/\n+$/, '');
        } finally {
            if (child.is_alive)
                ksyms.syscall(child.pid, ksyms.nr.__NR_exit, child.last_exit_status);
        }
    }

    _expand(token) {
        const substitutions = [];
        let expanded = this._replace_command_substitutions(token, substitutions);
        expanded = expanded
            .replaceAll('$$', String(this.pid))
            .replaceAll('$?', String(this.last_exit_status))
            .replace(/\$\{?(\d+)\}?/g, (_, index) =>
                index === '0'
                    ? this.argv0
                    : this.positional[Number(index) - 1] ?? '')
            .replace(/\$\{?(\w+)\}?/g, (_, k) => this.envp[k] ?? '')
            .replace(/^~/, this.home);
        substitutions.forEach((value, index) => {
            expanded = expanded.replaceAll(`\uE100${index}\uE101`, value);
        });
        return expanded;
    }

    _parse_pipeline(line) {
        return parse_pipeline(line, token => this._expand(token));
    }

    _builtin_cd(args, out) {
        const target = args[0] ?? this.home;
        const ret = ksyms.syscall(this._pid, ksyms.nr.__NR_chdir, target);
        if (ret.err) {
            out.push({text: `bash: cd: ${target}: No such file or directory`, tone: 'error'});
            return 1;
        }
        return 0;
    }

    _builtin_export(args, out) {
        for (const a of args) {
            const eq = a.indexOf('=');
            if (eq < 0) {
                out.push({text: `export: ${a}: not an assignment`, tone: 'warning'});
                continue;
            }
            ksyms.syscall(this._pid, ksyms.nr.__NR_setenv, a.slice(0, eq), a.slice(eq + 1));
        }
        return 0;
    }

    _builtin_su(args, out) {
        const target_user = args[0] ?? 'root';
        const password = args[1];
        const ret = ksyms.syscall(this._pid, ksyms.nr.__NR_su, target_user, password);
        if (ret.err) {
            out.push({text: 'su: Authentication failure', tone: 'error'});
            return 1;
        }
        const pw = ret.val;
        ksyms.syscall(this._pid, ksyms.nr.__NR_chdir, pw.home);
        out.push({text: `su: switched to '${target_user}'`, tone: 'success'});
        return 0;
    }

    _builtin_umask(args, out) {
        if (!args.length) {
            out.push({
                text: (this._task?.umask ?? 0o022).toString(8).padStart(4, '0'),
                tone: 'normal',
            });
            return 0;
        }
        if (!/^[0-7]{1,4}$/.test(args[0])) {
            out.push({text: `bash: umask: '${args[0]}': invalid mode`, tone: 'error'});
            return 1;
        }
        const ret = ksyms.syscall(
            this._pid, ksyms.nr.__NR_umask, parseInt(args[0], 8));
        return ret.err ? 1 : 0;
    }

    _builtin_unset(args) {
        if (!this.is_alive) return 1;
        for (const key of args)
            ksyms.syscall(this._pid, ksyms.nr.__NR_unsetenv, key);
        return 0;
    }

    _builtin_alias(args, out) {
        if (!args.length) {
            for (const [name, value] of [...this.aliases].sort())
                out.push({
                    text: `alias ${name}='${value.replaceAll("'", "'\\''")}'`,
                    tone: 'normal',
                });
            return 0;
        }
        let status = 0;
        for (const arg of args) {
            const equals = arg.indexOf('=');
            if (equals < 0) {
                const value = this.aliases.get(arg);
                if (value === undefined) {
                    out.push({
                        text: `bash: alias: ${arg}: not found`,
                        tone: 'error',
                    });
                    status = 1;
                } else {
                    out.push({
                        text: `alias ${arg}='${value.replaceAll("'", "'\\''")}'`,
                        tone: 'normal',
                    });
                }
                continue;
            }
            this.aliases.set(arg.slice(0, equals), arg.slice(equals + 1));
        }
        return status;
    }

    _builtin_unalias(args, out) {
        if (!args.length) {
            out.push({text: 'bash: unalias: usage: unalias name', tone: 'error'});
            return 2;
        }
        let status = 0;
        for (const name of args) {
            if (!this.aliases.delete(name)) {
                out.push({
                    text: `bash: unalias: ${name}: not found`,
                    tone: 'error',
                });
                status = 1;
            }
        }
        return status;
    }

    _builtin_help(args, out) {
        if (args.length) {
            let status = 0;
            for (const topic of args) {
                if (SHELL_BUILTIN_HELP[topic]) {
                    out.push({
                        text: SHELL_BUILTIN_HELP[topic],
                        tone: 'normal',
                    });
                } else {
                    out.push({
                        text: `bash: help: no help topics match '${topic}'`,
                        tone: 'error',
                    });
                    status = 1;
                }
            }
            return status;
        }

        out.push({text: 'JSNix bash builtins:', tone: 'success'});
        out.push({text: SHELL_BUILTINS.join('  '), tone: 'normal'});
        out.push({
            text: 'Use "man <program>" for external command manuals.',
            tone: 'muted',
        });
        return 0;
    }

    _emit_text(out, content) {
        const lines = String(content).split('\n');
        if (lines.at(-1) === '') lines.pop();
        for (const line of lines)
            out.push({text: line, tone: 'normal'});
    }

    _builtin_echo(args, out) {
        const no_nl = args[0] === '-n';
        out.push({
            text: (no_nl ? args.slice(1) : args).join(' '),
            tone: 'normal',
        });
        return 0;
    }

    _builtin_printf(args, out) {
        if (!args.length) return 0;
        let arg_index = 1;
        const output = args[0].replace(
            /%(%|s|d)|\\([nrt\\])/g,
            (_, format, escape) => {
                if (escape) return {
                    n: '\n', r: '\r', t: '\t', '\\': '\\',
                }[escape];
                if (format === '%') return '%';
                const value = args[arg_index++] ?? '';
                return format === 'd' ? String(Number(value) || 0) : value;
            });
        this._emit_text(out, output);
        return 0;
    }

    _builtin_read(args, out, stdin_data) {
        const name = args.find(arg => !arg.startsWith('-')) ?? 'REPLY';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            out.push({text: `bash: read: '${name}': not a valid identifier`, tone: 'error'});
            return 2;
        }
        const input = String(stdin_data ?? '');
        const line = input.split(/\r?\n/, 1)[0] ?? '';
        ksyms.syscall(this._pid, ksyms.nr.__NR_setenv, name, line);
        return input.length ? 0 : 1;
    }

    _evaluate_test(args) {
        if (!args.length) return false;
        if (args[0] === '!') return !this._evaluate_test(args.slice(1));
        if (args.length === 1) return args[0].length > 0;
        if (args.length === 2) {
            if (args[0] === '-n') return args[1].length > 0;
            if (args[0] === '-z') return args[1].length === 0;
            if (['-e', '-f', '-d', '-r', '-w', '-x'].includes(args[0])) {
                const stat = ksyms.syscall(
                    this.pid, ksyms.nr.__NR_stat, args[1]);
                if (stat.err) return false;
                if (args[0] === '-e') return true;
                if (args[0] === '-f') return stat.val.type === 'file';
                if (args[0] === '-d') return stat.val.type === 'dir';
                const mask = args[0] === '-r' ? 4 : args[0] === '-w' ? 2 : 1;
                return !ksyms.syscall(this.pid, ksyms.nr.__NR_access, path, mask).err;
            }
        }
        if (args.length === 3) {
            const [left, operator, right] = args;
            if (operator === '=' || operator === '==') return left === right;
            if (operator === '!=') return left !== right;
            if (operator === '-eq') return Number(left) === Number(right);
            if (operator === '-ne') return Number(left) !== Number(right);
            if (operator === '-lt') return Number(left) < Number(right);
            if (operator === '-le') return Number(left) <= Number(right);
            if (operator === '-gt') return Number(left) > Number(right);
            if (operator === '-ge') return Number(left) >= Number(right);
        }
        return false;
    }

    _builtin_test(args, out, bracket = false) {
        const test_args = bracket ? args.slice(0, -1) : args;
        if (bracket && args.at(-1) !== ']') {
            out.push({text: 'bash: [: missing `]`', tone: 'error'});
            return 2;
        }
        return this._evaluate_test(test_args) ? 0 : 1;
    }

    _builtin_type(args, out) {
        if (!args.length) {
            out.push({text: 'bash: type: missing operand', tone: 'error'});
            return 2;
        }
        let status = 0;
        for (const name of args.filter(arg => !arg.startsWith('-'))) {
            if (is_shell_reserved_word(name)) {
                out.push({text: `${name} is a shell keyword`, tone: 'normal'});
            } else if (this._is_shell_builtin(name)) {
                out.push({text: `${name} is a shell builtin`, tone: 'normal'});
            } else {
                const found = get_binary_path(name, this.pid);
                if (found) {
                    out.push({text: `${name} is ${found}`, tone: 'normal'});
                } else {
                    out.push({text: `bash: type: ${name}: not found`, tone: 'error'});
                    status = 1;
                }
            }
        }
        return status;
    }

    _builtin_kill(args, out) {
        let signo = 15;
        const rest = [...args];
        if (rest[0]?.startsWith('-') && /^-\d+$/.test(rest[0]))
            signo = Number(rest.shift().slice(1));
        if (!rest.length) {
            out.push({text: 'bash: kill: usage: kill [-signal] pid ...', tone: 'error'});
            return 2;
        }
        let status = 0;
        for (const value of rest) {
            if (String(value).startsWith('%')) {
                const job = this._find_job(value, out, 'kill');
                if (!job) {
                    status = 1;
                    continue;
                }
                if (signo === SIGSTOP) {
                    this._stop_job(job);
                    continue;
                }
                if (signo === SIGCONT) {
                    this._resume_job(job);
                    continue;
                }
                this._terminate_job(job, signo);
                continue;
            }
            const pid = Number(value);
            if (!Number.isInteger(pid)) {
                out.push({text: `bash: kill: ${value}: arguments must be process or job IDs`, tone: 'error'});
                status = 1;
                continue;
            }
            const job = this.jobs.find(item => item.pid === pid && !item.disowned);
            if (job) {
                if (signo === SIGSTOP) {
                    this._stop_job(job);
                    continue;
                }
                if (signo === SIGCONT) {
                    this._resume_job(job);
                    continue;
                }
                this._terminate_job(job, signo);
                continue;
            }
            const ret = ksyms.syscall(this.pid, ksyms.nr.__NR_kill, pid, signo);
            if (ret.err) {
                const message = ret.err === -EPERM
                    ? 'Operation not permitted'
                    : 'No such process';
                out.push({text: `bash: kill: (${pid}) - ${message}`, tone: 'error'});
                status = 1;
            }
        }
        return status;
    }

    _builtin_command(args, stdin_data) {
        if (args.includes('-v') || args.includes('-V')) {
            const buffer = [];
            const status = this._builtin_type(
                args.filter(arg => !arg.startsWith('-')),
                buffer,
            );
            return this._builtin_result(buffer, status);
        }
        const argv = args.filter(arg => !arg.startsWith('-'));
        if (!argv.length) return this._builtin_result([], 0);
        return this._run_builtin(argv[0], argv.slice(1), stdin_data) ??
            do_execve(this.pid, this.uid, this.gid, this.cwd, argv, stdin_data);
    }

    _unsupported_builtin(cmd, out) {
        out.push({
            text: `bash: ${cmd}: builtin recognized but not implemented`,
            tone: 'error',
        });
        return 2;
    }

    _builtin_exit(args) {
        const code = args[0] === undefined
            ? this.last_exit_status
            : Number(args[0]);
        this.last_exit_status = Number.isInteger(code)
            ? code & 0xff
            : 2;
        ksyms.syscall(
            this._pid, ksyms.nr.__NR_exit,
            this.last_exit_status);
        return this.last_exit_status;
    }

    _builtin_result(buffer, status) {
        return {
            pid: this.pid,
            executable: null,
            stdout_buf: buffer.filter(item => item.tone !== 'error'),
            stderr_buf: buffer.filter(item => item.tone === 'error'),
            exit_code: status,
            cwd: this.cwd,
            uid: this.uid,
            gid: this.gid,
            euid: this._task?.euid ?? this.uid,
            egid: this._task?.egid ?? this.gid,
            builtin: true,
        };
    }

    _is_shell_builtin(cmd) {
        return SHELL_BUILTINS.includes(cmd);
    }

    _fork_subshell() {
        const child = new Bash(this.uid, this.gid, {
            cwd: this.cwd,
            ppid: this.pid,
            argv0: this.argv0,
            args: this.positional,
            history: [...this.history],
            history_enabled: false,
            jobs: [],
        });
        child.aliases = new Map(this.aliases);
        return child;
    }

    _remove_session_frame(frame) {
        const index = this._session_stack.indexOf(frame);
        if (index >= 0) this._session_stack.splice(index, 1);
        ksyms.unregister_exit_handler(frame.child_pid, frame.child_key);
        ksyms.unregister_exit_handler(frame.parent_pid, frame.parent_key);
    }

    _restore_parent_session(frame, exit_code) {
        this._remove_session_frame(frame);
        this.last_exit_status = exit_code ?? this.last_exit_status;

        if (this._pid !== frame.child_pid) return;
        const parent = ksyms.get_task(frame.parent_pid);
        if (parent && parent.state !== TASK_ZOMBIE) {
            this._pid = frame.parent_pid;
            ksyms.syscall(
                frame.parent_pid,
                ksyms.nr.__NR_wait4,
                frame.child_pid,
                ksyms.types.WNOHANG,
            );
        }
    }

    _terminate_child_session(frame) {
        ksyms.unregister_exit_handler(frame.parent_pid, frame.parent_key);
        const child = ksyms.get_task(frame.child_pid);
        if (!child || child.state === TASK_ZOMBIE) return;
        ksyms.syscall(
            frame.child_pid,
            ksyms.nr.__NR_kill,
            frame.child_pid,
            SIGTERM,
        );
    }

    _enter_shell_session(child_pid) {
        const parent_pid = this._pid;
        const frame = {
            parent_pid,
            child_pid,
            child_key: `bash_child_session_${parent_pid}_${child_pid}`,
            parent_key: `bash_parent_session_${parent_pid}_${child_pid}`,
        };
        this._session_stack.push(frame);
        ksyms.register_exit_handler(
            child_pid,
            frame.child_key,
            (_dead_pid, exit_code) =>
                this._restore_parent_session(frame, exit_code),
        );
        ksyms.register_exit_handler(
            parent_pid,
            frame.parent_key,
            () => this._terminate_child_session(frame),
        );
        this._pid = child_pid;
    }

    _run_builtin(cmd, argv, stdin_data) {
        const buffer = [];
        let status = null;

        if (cmd === ':') status = 0;
        else if (cmd === 'cd') status = this._builtin_cd(argv, buffer);
        else if (cmd === 'export') status = this._builtin_export(argv, buffer);
        else if (cmd === 'umask') status = this._builtin_umask(argv, buffer);
        else if (cmd === 'unset') status = this._builtin_unset(argv);
        else if (cmd === 'alias') status = this._builtin_alias(argv, buffer);
        else if (cmd === 'unalias') status = this._builtin_unalias(argv, buffer);
        else if (cmd === 'help') status = this._builtin_help(argv, buffer);
        else if (cmd === 'source' || cmd === '.') status = this._builtin_source(argv, buffer);
        else if (cmd === 'exit' || cmd === 'logout') status = this._builtin_exit(argv);
        else if (cmd === 'history') {
            this.history.forEach((entry, index) =>
                buffer.push({
                    text: `  ${String(index + 1).padStart(4)}  ${entry}`,
                    tone: 'normal',
                }));
            status = 0;
        } else if (cmd === 'echo') status = this._builtin_echo(argv, buffer);
        else if (cmd === 'printf') status = this._builtin_printf(argv, buffer);
        else if (cmd === 'test') status = this._builtin_test(argv, buffer, false);
        else if (cmd === '[') status = this._builtin_test(argv, buffer, true);
        else if (cmd === 'type') status = this._builtin_type(argv, buffer);
        else if (cmd === 'kill') status = this._builtin_kill(argv, buffer);
        else if (cmd === 'pwd') {
            buffer.push({text: this.cwd, tone: 'normal'});
            status = 0;
        } else if (cmd === 'true') status = 0;
        else if (cmd === 'false') status = 1;
        else if (cmd === 'read') status = this._builtin_read(argv, buffer, stdin_data);
        else if (cmd === 'jobs') status = this._builtin_jobs(argv, buffer);
        else if (cmd === 'bg') status = this._builtin_bg(argv, buffer);
        else if (cmd === 'fg') status = this._builtin_fg(argv, buffer);
        else if (cmd === 'wait') status = this._builtin_wait(argv, buffer);
        else if (cmd === 'disown') status = this._builtin_disown(argv, buffer);
        else if (cmd === 'eval') {
            const output = this.execute(argv.join(' '), {record_history: false});
            buffer.push(...output);
            status = this.last_exit_status;
        } else if (cmd === 'shift') {
            const count = argv[0] === undefined ? 1 : Number(argv[0]);
            if (!Number.isInteger(count) || count < 0 || count > this.positional.length) {
                buffer.push({text: 'bash: shift: shift count out of range', tone: 'error'});
                status = 1;
            } else {
                this.positional.splice(0, count);
                status = 0;
            }
        } else if (cmd === 'return') {
            const code = argv[0] === undefined ? this.last_exit_status : Number(argv[0]);
            status = Number.isInteger(code) ? code & 0xff : 2;
        } else if (cmd === 'set') {
            if (argv.length) this.positional = [...argv];
            status = 0;
        } else if (cmd === 'readonly') {
            status = 0;
        } else if (cmd === 'builtin') {
            if (!argv.length) status = 0;
            else if (!this._is_shell_builtin(argv[0])) {
                buffer.push({text: `bash: builtin: ${argv[0]}: not a shell builtin`, tone: 'error'});
                status = 1;
            } else {
                return this._run_builtin(argv[0], argv.slice(1), stdin_data);
            }
        } else if (cmd === 'command') {
            const result = this._builtin_command(argv, stdin_data);
            this.last_exit_status = result?.exit_code ?? 127;
            return result;
        } else if (cmd === 'exec') {
            if (!argv.length) status = 0;
            else {
                const result = do_execve_in_place(this.pid, argv, stdin_data);
                if (!result) {
                    buffer.push({
                        text: `bash: exec: ${argv[0]}: not found`,
                        tone: 'error',
                    });
                    status = 127;
                } else {
                    this.last_exit_status = result.exit_code;
                    return result;
                }
            }
        } else if (this._is_shell_builtin(cmd)) status = this._unsupported_builtin(cmd, buffer);

        if (status === null) return null;
        this.last_exit_status = status;
        return this._builtin_result(buffer, status);
    }

    async _run_builtin_async(cmd, argv, stdin_data) {
        if (cmd === 'fg') return this._builtin_fg_async(argv);
        if (cmd === 'wait') return this._builtin_wait_async(argv);
        return this._run_builtin(cmd, argv, stdin_data);
    }

    _run_builtin_stage(cmd, argv, stdin_data, forked) {
        if (!this._is_shell_builtin(cmd)) return null;
        if (!forked) return this._run_builtin(cmd, argv, stdin_data);

        const child = this._fork_subshell();
        try {
            const result = child._run_builtin(cmd, argv, stdin_data);
            if (result) result.pid = child.pid;
            return result;
        } finally {
            if (child.is_alive)
                ksyms.syscall(child.pid, ksyms.nr.__NR_exit, child.last_exit_status);
        }
    }

    async _run_builtin_stage_async(cmd, argv, stdin_data, forked) {
        if (!this._is_shell_builtin(cmd)) return null;
        if (!forked) return this._run_builtin_async(cmd, argv, stdin_data);

        const child = this._fork_subshell();
        try {
            const result = await child._run_builtin_async(cmd, argv, stdin_data);
            if (result) result.pid = child.pid;
            return result;
        } finally {
            if (child.is_alive)
                ksyms.syscall(child.pid, ksyms.nr.__NR_exit, child.last_exit_status);
        }
    }

    _expand_alias(line) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?=\s|$)/);
        if (!match) return line;
        const replacement = this.aliases.get(match[1]);
        return replacement === undefined
            ? line
            : replacement + line.slice(match[1].length);
    }

    _expand_glob(token) {
        if (!/[*?]/.test(token) && !(token.includes('[') && token.includes(']')))
            return [token];
        const slash = token.lastIndexOf('/');
        const directory = slash >= 0 ? token.slice(0, slash) || '/' : '.';
        const pattern = slash >= 0 ? token.slice(slash + 1) : token;
        const expression = new RegExp('^' + pattern
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
            .replace(/\[!([^\]]+)\]/g, '[^$1]') + '$');
        const result = ksyms.syscall(
            this._pid, ksyms.nr.__NR_getdents, directory);
        if (result.err) return [token];
        const matches = result.val
            .filter(name => pattern.startsWith('.') || !name.startsWith('.'))
            .filter(name => expression.test(name))
            .map(name => slash >= 0
                ? `${token.slice(0, slash + 1)}${name}`
                : name);
        return matches.length ? matches : [token];
    }

    _builtin_source(args, out) {
        const path = args[0];
        if (!path) {
            out.push({text: 'bash: source: filename argument required', tone: 'error'});
            return 2;
        }
        const result = ksyms.syscall(
            this._pid, ksyms.nr.__NR_readfile,
            path);
        if (result.err) {
            out.push({
                text: `bash: ${path}: No such file or directory`,
                tone: 'error',
            });
            return 1;
        }
        for (const command of result.val.split('\n')) {
            const trimmed = command.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            out.push(...this.execute(trimmed, {record_history: false}));
            if (!this.is_alive) break;
        }
        return this.last_exit_status;
    }

    _buffer_to_text(buffer) {
        if (!buffer.length) return '';
        const text = buffer.map(line => line.text ?? '').join('\n');
        return buffer.at(-1)?.text === '' ? text : text + '\n';
    }

    _parse_command_list(line) {
        return parse_command_list(line);
    }

    _is_text_script(content) {
        const bytes = String(content ?? '');
        if (!bytes.length || bytes.includes('\0')) return false;
        return [...bytes].every(char => {
            const code = char.charCodeAt(0);
            return code === 9 ||
                code === 10 ||
                code === 13 ||
                (code >= 32 && code < 127);
        });
    }

    _script_lines(content) {
        const lines = [];
        for (const raw_line of String(content ?? '').split(/\r?\n/)) {
            for (const statement of this._split_script_statements(raw_line)) {
                lines.push(...this._normalize_script_statement(statement));
            }
        }
        return lines;
    }

    _split_script_statements(raw_line) {
        const statements = [];
        let statement = '';
        let quote = null;
        let escaped = false;

        for (const char of String(raw_line ?? '')) {
            if (escaped) {
                statement += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                statement += char;
                escaped = true;
                continue;
            }
            if (quote) {
                statement += char;
                if (char === quote) quote = null;
                continue;
            }
            if (char === '\'' || char === '"') {
                statement += char;
                quote = char;
                continue;
            }
            if (char === ';') {
                const trimmed = statement.trim();
                if (trimmed) statements.push(trimmed);
                statement = '';
                continue;
            }
            statement += char;
        }

        const trimmed = statement.trim();
        if (trimmed) statements.push(trimmed);
        return statements;
    }

    _normalize_script_statement(statement) {
        const trimmed = String(statement ?? '').trim();
        if (!trimmed || trimmed.startsWith('#')) return [];

        const marker = trimmed.match(/^(then|do|else)\s+(.+)$/);
        if (marker)
            return [marker[1], marker[2].trim()].filter(Boolean);
        return [trimmed];
    }

    _append_script_output(output, stdout_buf, stderr_buf) {
        for (const item of output) {
            if (item.tone === 'error') stderr_buf.push(item);
            else stdout_buf.push(item);
        }
    }

    _find_script_block(lines, start, open_word, close_word, middle_word = null) {
        let depth = 0;
        let middle = -1;
        for (let index = start; index < lines.length; index++) {
            const line = lines[index];
            if (line.startsWith(`${open_word} `)) depth++;
            if (middle_word && depth === 1 && line === middle_word) {
                middle = index;
                continue;
            }
            if (line === close_word) {
                depth--;
                if (depth === 0)
                    return {end: index, middle};
            }
        }
        return null;
    }

    _split_control_header(line, keyword, marker) {
        let header = line.slice(keyword.length).trim();
        let inline_marker = false;
        const suffix = new RegExp(`;\\s*${marker}$`);
        if (suffix.test(header)) {
            header = header.replace(suffix, '').trim();
            inline_marker = true;
        }
        return {header, inline_marker};
    }

    _run_script_command(line, stdout_buf, stderr_buf) {
        this._append_script_output(
            this.execute(line, {record_history: false}),
            stdout_buf,
            stderr_buf,
        );
        return this.last_exit_status;
    }

    async _run_script_command_async(line, stdout_buf, stderr_buf) {
        this._append_script_output(
            await this.execute_async(line, {record_history: false}),
            stdout_buf,
            stderr_buf,
        );
        return this.last_exit_status;
    }

    _run_script_lines(lines, stdout_buf, stderr_buf) {
        lines = this._script_lines(lines.join('\n'));
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (line === 'then' || line === 'do' ||
                line === 'else' || line === 'fi' || line === 'done') {
                stderr_buf.push({
                    text: `bash: syntax error near unexpected token '${line}'`,
                    tone: 'error',
                });
                this.last_exit_status = 2;
                return;
            }

            if (line.startsWith('if ')) {
                const parsed = this._split_control_header(line, 'if', 'then');
                let body_start = index + 1;
                if (!parsed.inline_marker) {
                    if (lines[body_start] !== 'then') {
                        stderr_buf.push({
                            text: 'bash: syntax error: expected then',
                            tone: 'error',
                        });
                        this.last_exit_status = 2;
                        return;
                    }
                    body_start++;
                }
                const block = this._find_script_block(lines, index, 'if', 'fi', 'else');
                if (!block) {
                    stderr_buf.push({
                        text: 'bash: syntax error: unexpected end of file',
                        tone: 'error',
                    });
                    this.last_exit_status = 2;
                    return;
                }
                this._run_script_command(parsed.header, stdout_buf, stderr_buf);
                const selected = this.last_exit_status === 0
                    ? lines.slice(body_start, block.middle >= 0 ? block.middle : block.end)
                    : block.middle >= 0
                        ? lines.slice(block.middle + 1, block.end)
                        : [];
                this._run_script_lines(selected, stdout_buf, stderr_buf);
                index = block.end;
                if (!this.is_alive) return;
                continue;
            }

            if (line.startsWith('for ')) {
                const parsed = this._split_control_header(line, 'for', 'do');
                let body_start = index + 1;
                if (!parsed.inline_marker) {
                    if (lines[body_start] !== 'do') {
                        stderr_buf.push({
                            text: 'bash: syntax error: expected do',
                            tone: 'error',
                        });
                        this.last_exit_status = 2;
                        return;
                    }
                    body_start++;
                }
                const block = this._find_script_block(lines, index, 'for', 'done');
                if (!block) {
                    stderr_buf.push({
                        text: 'bash: syntax error: unexpected end of file',
                        tone: 'error',
                    });
                    this.last_exit_status = 2;
                    return;
                }
                const match = parsed.header.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/);
                if (!match) {
                    stderr_buf.push({
                        text: 'bash: for: supported form is: for name in words; do',
                        tone: 'error',
                    });
                    this.last_exit_status = 2;
                    return;
                }
                const [, name, words] = match;
                for (const value of this._tokenize(words)) {
                    ksyms.syscall(this.pid, ksyms.nr.__NR_setenv, name, value);
                    this._run_script_lines(
                        lines.slice(body_start, block.end),
                        stdout_buf,
                        stderr_buf,
                    );
                    if (!this.is_alive) break;
                }
                index = block.end;
                continue;
            }

            if (line.startsWith('while ')) {
                const parsed = this._split_control_header(line, 'while', 'do');
                let body_start = index + 1;
                if (!parsed.inline_marker) {
                    if (lines[body_start] !== 'do') {
                        stderr_buf.push({
                            text: 'bash: syntax error: expected do',
                            tone: 'error',
                        });
                        this.last_exit_status = 2;
                        return;
                    }
                    body_start++;
                }
                const block = this._find_script_block(lines, index, 'while', 'done');
                if (!block) {
                    stderr_buf.push({
                        text: 'bash: syntax error: unexpected end of file',
                        tone: 'error',
                    });
                    this.last_exit_status = 2;
                    return;
                }
                let guard = 0;
                let ran_body = false;
                let body_status = 0;
                while (this.is_alive && guard++ < 1000) {
                    this._run_script_command(parsed.header, stdout_buf, stderr_buf);
                    if (this.last_exit_status !== 0) break;
                    this._run_script_lines(
                        lines.slice(body_start, block.end),
                        stdout_buf,
                        stderr_buf,
                    );
                    ran_body = true;
                    body_status = this.last_exit_status;
                    if (!this.is_alive) return;
                }
                if (guard > 1000) {
                    stderr_buf.push({
                        text: 'bash: while: maximum loop count exceeded',
                        tone: 'error',
                    });
                    this.last_exit_status = 1;
                } else {
                    this.last_exit_status = ran_body ? body_status : 0;
                }
                index = block.end;
                continue;
            }

            this._run_script_command(line, stdout_buf, stderr_buf);
            if (!this.is_alive) return;
        }
    }

    run_script_text(content, options = {}) {
        const previous_argv0 = this.argv0;
        const previous_positional = this.positional;
        this.argv0 = options.argv0 ?? this.argv0;
        this.positional = [...(options.args ?? [])];

        const stdout_buf = [];
        const stderr_buf = [];
        if (options.stdin)
            ksyms.syscall(this.pid, ksyms.nr.__NR_setenv, 'STDIN', options.stdin);

        const source = String(content ?? '');
        this._run_script_lines(
            source.split(/\r?\n/),
            stdout_buf,
            stderr_buf,
        );

        const exit_code = this.last_exit_status;
        this.argv0 = previous_argv0;
        this.positional = previous_positional;
        return {stdout_buf, stderr_buf, exit_code};
    }

    script_text_needs_async(content) {
        const lines = this._script_lines(String(content ?? ''));
        for (const line of lines) {
            if (line === 'then' || line === 'do' ||
                line === 'else' || line === 'fi' || line === 'done')
                continue;

            if (line.startsWith('if ')) {
                const parsed = this._split_control_header(line, 'if', 'then');
                if (this._line_needs_async(parsed.header)) return true;
                continue;
            }
            if (line.startsWith('while ')) {
                const parsed = this._split_control_header(line, 'while', 'do');
                if (this._line_needs_async(parsed.header)) return true;
                continue;
            }
            if (line.startsWith('for ')) continue;
            if (this._line_needs_async(line)) return true;
        }
        return false;
    }

    async run_script_text_async(content, options = {}) {
        const previous_argv0 = this.argv0;
        const previous_positional = this.positional;
        this.argv0 = options.argv0 ?? this.argv0;
        this.positional = [...(options.args ?? [])];

        const stdout_buf = [];
        const stderr_buf = [];
        if (options.stdin)
            ksyms.syscall(this.pid, ksyms.nr.__NR_setenv, 'STDIN', options.stdin);

        const lines = this._script_lines(String(content ?? ''));
        for (const line of lines) {
            if (line === 'then' || line === 'do' ||
                line === 'else' || line === 'fi' || line === 'done') {
                stderr_buf.push({
                    text: `bash: syntax error near unexpected token '${line}'`,
                    tone: 'error',
                });
                this.last_exit_status = 2;
                break;
            }
            if (/^(if|for|while)\s/.test(line)) {
                const result = this.run_script_text(lines.join('\n'), options);
                stdout_buf.push(...result.stdout_buf);
                stderr_buf.push(...result.stderr_buf);
                this.last_exit_status = result.exit_code;
                break;
            }
            await this._run_script_command_async(line, stdout_buf, stderr_buf);
            if (!this.is_alive) break;
        }

        const exit_code = this.last_exit_status;
        this.argv0 = previous_argv0;
        this.positional = previous_positional;
        return {stdout_buf, stderr_buf, exit_code};
    }

    _run_shell_script(path, args, stdin_data) {
        let content;
        try {
            const read = ksyms.syscall(this._pid, ksyms.nr.__NR_readfile, path);
            if (read.err) return null;
            content = read.val;
        } catch {
            return null;
        }
        if (!this._is_text_script(content)) return null;

        const child = new Bash(this.uid, this.gid, {
            cwd: this.cwd,
            ppid: this.pid,
            argv0: path,
            args,
            history_enabled: false,
        });

        const result = child.run_script_text(content, {
            argv0: path,
            args,
            stdin: stdin_data,
            mode: 'auto',
        });
        const exit_code = result.exit_code;
        if (child.is_alive)
            ksyms.syscall(child.pid, ksyms.nr.__NR_exit, exit_code);
        return {
            pid: child.pid,
            executable: path,
            stdout_buf: result.stdout_buf,
            stderr_buf: result.stderr_buf,
            exit_code,
            cwd: this.cwd,
            uid: this.uid,
            gid: this.gid,
            euid: this.uid,
            egid: this.gid,
            shell_fallback: true,
        };
    }

    execute(line, options = {}) {
        return this._execute(line, options, false);
    }

    execute_interactive(line, options = {}) {
        return this._execute(line, options, true);
    }

    execute_async(line, options = {}) {
        return Promise.resolve(this.execute_interactive(line, options));
    }

    _line_needs_async(command) {
        let pipeline;
        try {
            pipeline = this._parse_pipeline(this._expand_alias(command));
        } catch {
            return false;
        }
        return pipeline.some(stage => {
            const tokens = [...stage.tokens];
            while (tokens[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/))
                tokens.shift();
            const cmd = tokens[0];
            if (!cmd) return false;
            if (this._is_shell_builtin(cmd))
                return cmd === 'fg' || cmd === 'wait';
            return executable_needs_async(this.pid, cmd);
        });
    }

    _execute(line, options = {}, allow_async = false) {
        line = line.trim();
        if (!line || line.startsWith('#')) return [];
        if (!this.is_alive)
            return [{text: 'bash: session terminated', tone: 'error'}];

        const record_history =
            options.record_history ??
            this.history_enabled;
        if (record_history) this.history.push(line);

        let commands;
        try {
            commands = this._parse_command_list(line);
        } catch (e) {
            this.last_exit_status = 2;
            return [{text: `bash: ${e.message}`, tone: 'error'}];
        }

        const output = [];
        for (let index = 0; index < commands.length; index++) {
            const {operator, command, background} = commands[index];
            if (operator === '&&' && this.last_exit_status !== 0) continue;
            if (operator === '||' && this.last_exit_status === 0) continue;
            if (allow_async && !background && this._line_needs_async(command))
                return this._execute_command_list_async(commands, index, output);
            output.push(...(background
                ? this._start_background_job(command)
                : this._execute_pipeline_line(command)));
            if (!this.is_alive) break;
        }
        return output;
    }

    async _execute_command_list_async(commands, start_index, output) {
        for (let index = start_index; index < commands.length; index++) {
            const {operator, command, background} = commands[index];
            if (operator === '&&' && this.last_exit_status !== 0) continue;
            if (operator === '||' && this.last_exit_status === 0) continue;
            output.push(...(background
                ? this._start_background_job(command)
                : await this._execute_pipeline_line_async(command)));
            if (!this.is_alive) break;
        }
        return output;
    }

    _unwrap_command_group(line, open, close) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return null;

        let depth = 0;
        let quote = null;
        let escaped = false;
        for (let index = 0; index < trimmed.length; index++) {
            const char = trimmed[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (quote) {
                if (char === quote) quote = null;
                continue;
            }
            if (char === '\'' || char === '"') {
                quote = char;
                continue;
            }
            if (char === open) depth++;
            else if (char === close) {
                depth--;
                if (depth === 0 && index !== trimmed.length - 1) return null;
            }
        }
        return depth === 0 ? trimmed.slice(1, -1).trim() : null;
    }

    _execute_subshell(command) {
        const child = this._fork_subshell();
        try {
            const output = child.execute(command, {record_history: false});
            this.last_exit_status = child.last_exit_status;
            return output;
        } finally {
            if (child.is_alive)
                ksyms.syscall(child.pid, ksyms.nr.__NR_exit, child.last_exit_status);
        }
    }

    async _execute_subshell_async(command) {
        const child = this._fork_subshell();
        try {
            const output = await child.execute_async(command, {record_history: false});
            this.last_exit_status = child.last_exit_status;
            return output;
        } finally {
            if (child.is_alive)
                ksyms.syscall(child.pid, ksyms.nr.__NR_exit, child.last_exit_status);
        }
    }

    async _execute_pipeline_line_async(line) {
        if (!this._line_needs_async(line))
            return this._execute_pipeline_line(line);

        line = this._expand_alias(line);
        const subshell = this._unwrap_command_group(line, '(', ')');
        if (subshell !== null) return this._execute_subshell_async(subshell);
        const group = this._unwrap_command_group(line, '{', '}');
        if (group !== null) {
            const command = group.replace(/;\s*$/, '');
            return this.execute_async(command, {record_history: false});
        }

        let pipeline;
        try {
            pipeline = this._parse_pipeline(line);
        } catch (e) {
            this.last_exit_status = 2;
            return [{text: `bash: ${e.message}`, tone: 'error'}];
        }
        if (pipeline.length !== 1)
            return this._execute_external_pipeline_async(pipeline, line);

        const stage = pipeline[0];
        const {
            tokens,
            redir_out,
            redir_in,
            redir_append,
            redir_err,
            redir_err_append,
            here_string,
        } = stage;
        if (!tokens.length) return [];
        const argv_tokens = [...tokens];
        const assignments = [];
        while (argv_tokens[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/))
            assignments.push(argv_tokens.shift());
        if (!argv_tokens.length) {
            for (const assignment of assignments) {
                const equals = assignment.indexOf('=');
                ksyms.syscall(
                    this._pid,
                    ksyms.nr.__NR_setenv,
                    assignment.slice(0, equals),
                    assignment.slice(equals + 1),
                );
            }
            this.last_exit_status = 0;
            return [];
        }

        const [cmd, ...raw_argv] = argv_tokens;
        const argv = raw_argv.flatMap(arg => this._expand_glob(arg));
        if (!this._is_shell_builtin(cmd))
            return this._execute_external_pipeline_async(pipeline, line);
        let stdin_data = '';
        const all_output = [];

        if (here_string !== null) {
            stdin_data = here_string + '\n';
        } else if (redir_in) {
            const r = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_readfile,
                redir_in,
            );
            if (r.err) {
                this.last_exit_status = 1;
                return [{
                    text: `bash: ${redir_in}: ${r.err === -13 ? 'Permission denied' : 'No such file or directory'}`,
                    tone: 'error',
                }];
            }
            stdin_data = r.val;
        }

        const saved_env = {};
        for (const assignment of assignments) {
            const equals = assignment.indexOf('=');
            const key = assignment.slice(0, equals);
            const envp = this.envp;
            saved_env[key] = {
                exists: Object.hasOwn(envp, key),
                value: envp[key],
            };
            ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_setenv,
                key,
                assignment.slice(equals + 1),
            );
        }

        let exec_result = null;
        if (this._is_shell_builtin(cmd)) {
            exec_result = await this._run_builtin_stage_async(
                cmd,
                argv,
                stdin_data,
                false,
            );
        }
        if (!exec_result) {
            const promise = do_execve_async(
                this._pid,
                this.uid,
                this.gid,
                this.cwd,
                [cmd, ...argv],
                stdin_data,
            );
            if (promise?.pid) this.foreground_pid = promise.pid;
            try {
                exec_result = await promise;
            } finally {
                if (this.foreground_pid === promise?.pid)
                    this.foreground_pid = null;
            }
            if (exec_result?.errno === ENOEXEC) {
                const fallback = this._run_shell_script(
                    exec_result.path,
                    argv,
                    stdin_data,
                );
                if (fallback) exec_result = fallback;
            }
        }

        for (const [key, saved] of Object.entries(saved_env)) {
            if (saved.exists)
                ksyms.syscall(this._pid, ksyms.nr.__NR_setenv, key, saved.value);
            else
                ksyms.syscall(this._pid, ksyms.nr.__NR_unsetenv, key);
        }

        if (!exec_result) {
            this.last_exit_status = 127;
            return [{text: `bash: ${cmd}: command not found`, tone: 'error'}];
        }

        const shell_session = exec_result.stdout_buf.find(item =>
            item?.type === 'control' &&
            item.action === 'shell-session');
        if (shell_session) {
            const child = ksyms.get_task(shell_session.pid);
            exec_result.stdout_buf.splice(
                exec_result.stdout_buf.indexOf(shell_session),
                1,
            );
            if (!child ||
                ![
                    '/bin/bash',
                    '/bin/dash',
                    '/bin/sh',
                    '/usr/bin/bash',
                    '/usr/bin/dash',
                    '/usr/bin/sh',
                ].includes(child.executable)) {
                exec_result.stderr_buf.push({
                    text: 'bash: invalid child shell session',
                    tone: 'error',
                });
                exec_result.exit_code = 1;
            } else {
                this._enter_shell_session(child.pid);
            }
        }

        this.last_exit_status = exec_result.exit_code;
        let stderr_redirected = false;

        if (redir_err) {
            const error_text = this._buffer_to_text(exec_result.stderr_buf);
            const written = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_writefile,
                redir_err,
                error_text,
                redir_err_append,
            );
            if (written.err) {
                all_output.push({
                    text: `bash: ${redir_err}: Cannot create file`,
                    tone: 'error',
                });
                this.last_exit_status = 1;
            } else {
                stderr_redirected = true;
            }
        }

        if (redir_out) {
            const written = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_writefile,
                redir_out,
                this._buffer_to_text(exec_result.stdout_buf),
                redir_append,
            );
            if (written.err) {
                all_output.push({
                    text: `bash: ${redir_out}: ${written.err === -13 ? 'Permission denied' : 'Cannot create file'}`,
                    tone: 'error',
                });
                this.last_exit_status = 1;
            }
        } else {
            all_output.push(...exec_result.stdout_buf);
        }
        if (!stderr_redirected) all_output.push(...exec_result.stderr_buf);
        if (exec_result.stdout_buf.some(item => item.special === 'clear'))
            return [{special: 'clear'}];
        return all_output;
    }

    async _execute_external_pipeline_async(pipeline, original_line) {
        const commands = pipeline.map(stage => {
            const tokens = [...stage.tokens];
            const assignments = [];
            while (tokens[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/))
                assignments.push(tokens.shift());
            return {stage, tokens, assignments};
        });
        if (commands.some(({tokens}) =>
            tokens[0] && this._is_shell_builtin(tokens[0])))
            return this._execute_pipeline_line(original_line);

        const pipes = Array.from(
            {length: Math.max(0, pipeline.length - 1)},
            () => ksyms.syscall(this._pid, ksyms.nr.__NR_pipe).val,
        );
        const pipe_fds = pipes.flat();
        const runners = [];
        let pipeline_pgid = null;

        try {
            for (let index = 0; index < commands.length; index++) {
                const {stage, tokens, assignments} = commands[index];
                if (!tokens.length) continue;
                const [cmd, ...raw_argv] = tokens;
                const argv = raw_argv.flatMap(arg => this._expand_glob(arg));
                let stdin_data = '';
                let use_pipe_input = index > 0;
                let use_pipe_output = index < commands.length - 1;
                let input_fd = use_pipe_input ? pipes[index - 1][0] : null;
                let output_fd = null;
                let error_fd = null;

                if (stage.here_string !== null) {
                    use_pipe_input = false;
                    const here_pipe = ksyms.syscall(
                        this._pid, ksyms.nr.__NR_pipe).val;
                    ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_write,
                        here_pipe[1],
                        stage.here_string + '\n',
                    );
                    ksyms.syscall(
                        this._pid, ksyms.nr.__NR_close, here_pipe[1]);
                    input_fd = here_pipe[0];
                } else if (stage.redir_in) {
                    const opened = ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_open,
                        stage.redir_in,
                        ksyms.types.O_RDONLY,
                    );
                    if (opened.err) {
                        this.last_exit_status = 1;
                        return [{
                            text: `bash: ${stage.redir_in}: ${opened.err === -13 ? 'Permission denied' : 'No such file or directory'}`,
                            tone: 'error',
                        }];
                    }
                    input_fd = opened.val;
                    use_pipe_input = false;
                }
                if (stage.redir_out) {
                    use_pipe_output = false;
                    const flags = ksyms.types.O_WRONLY |
                        ksyms.types.O_CREAT |
                        (stage.redir_append
                            ? ksyms.types.O_APPEND
                            : ksyms.types.O_TRUNC);
                    const opened = ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_open,
                        stage.redir_out,
                        flags,
                        0o666,
                    );
                    if (opened.err) {
                        if (input_fd !== null && !use_pipe_input)
                            ksyms.syscall(
                                this._pid, ksyms.nr.__NR_close, input_fd);
                        this.last_exit_status = 1;
                        return [{
                            text: `bash: ${stage.redir_out}: ${opened.err === -13 ? 'Permission denied' : 'Cannot create file'}`,
                            tone: 'error',
                        }];
                    }
                    output_fd = opened.val;
                }
                if (stage.redir_err) {
                    const flags = ksyms.types.O_WRONLY |
                        ksyms.types.O_CREAT |
                        (stage.redir_err_append
                            ? ksyms.types.O_APPEND
                            : ksyms.types.O_TRUNC);
                    const opened = ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_open,
                        stage.redir_err,
                        flags,
                        0o666,
                    );
                    if (opened.err) {
                        for (const fd of [input_fd, output_fd]) {
                            if (fd !== null && !pipe_fds.includes(fd))
                                ksyms.syscall(
                                    this._pid, ksyms.nr.__NR_close, fd);
                        }
                        this.last_exit_status = 1;
                        return [{
                            text: `bash: ${stage.redir_err}: Cannot create file`,
                            tone: 'error',
                        }];
                    }
                    error_fd = opened.val;
                }

                const saved_env = {};
                for (const assignment of assignments) {
                    const equals = assignment.indexOf('=');
                    const key = assignment.slice(0, equals);
                    const envp = this.envp;
                    saved_env[key] = {
                        exists: Object.hasOwn(envp, key),
                        value: envp[key],
                    };
                    ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_setenv,
                        key,
                        assignment.slice(equals + 1),
                    );
                }

                const fd_map = {};
                const preserve_fds = [];
                if (input_fd !== null) {
                    fd_map[0] = input_fd;
                    preserve_fds.push(0);
                }
                if (use_pipe_output) {
                    fd_map[1] = pipes[index][1];
                    preserve_fds.push(1);
                } else if (output_fd !== null) {
                    fd_map[1] = output_fd;
                    preserve_fds.push(1);
                }
                if (error_fd !== null) {
                    fd_map[2] = error_fd;
                    preserve_fds.push(2);
                }
                const extra_fds = [input_fd, output_fd, error_fd]
                    .filter(fd => fd !== null && !pipe_fds.includes(fd));
                const promise = do_execve_async(
                    this._pid,
                    this.uid,
                    this.gid,
                    this.cwd,
                    [cmd, ...argv],
                    stdin_data,
                    0,
                    {
                        fd_map,
                        close_fds: [...pipe_fds, ...extra_fds],
                        preserve_fds,
                        process_group: pipeline_pgid ?? 'new',
                    },
                );
                pipeline_pgid ??= promise?.pid ?? null;
                for (const fd of extra_fds)
                    ksyms.syscall(this._pid, ksyms.nr.__NR_close, fd);

                for (const [key, saved] of Object.entries(saved_env)) {
                    if (saved.exists)
                        ksyms.syscall(
                            this._pid, ksyms.nr.__NR_setenv, key, saved.value);
                    else
                        ksyms.syscall(
                            this._pid, ksyms.nr.__NR_unsetenv, key);
                }
                runners.push({promise, stage, cmd});
            }
        } finally {
            for (const fd of pipe_fds)
                ksyms.syscall(this._pid, ksyms.nr.__NR_close, fd);
        }

        const foreground = runners.at(-1)?.promise?.pid ?? null;
        if (foreground) this.foreground_pid = foreground;
        if (pipeline_pgid) {
            this.foreground_pgid = pipeline_pgid;
            ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_ioctl,
                0,
                ksyms.types.TIOCSPGRP,
                pipeline_pgid,
            );
        }
        let results;
        try {
            results = await Promise.all(
                runners.map(({promise}) => Promise.resolve(promise)));
        } finally {
            if (this.foreground_pid === foreground) this.foreground_pid = null;
            if (this.foreground_pgid === pipeline_pgid) {
                this.foreground_pgid = null;
                const shell_pgid = ksyms.syscall(
                    this._pid, ksyms.nr.__NR_getpgid, 0).val;
                ksyms.syscall(
                    this._pid,
                    ksyms.nr.__NR_ioctl,
                    0,
                    ksyms.types.TIOCSPGRP,
                    shell_pgid,
                );
            }
        }

        const output = [];
        for (let index = 0; index < runners.length; index++) {
            const {stage, cmd} = runners[index];
            const result = results[index];
            const is_last = index === runners.length - 1;
            if (!result) {
                output.push({
                    text: `bash: ${cmd}: command not found`,
                    tone: 'error',
                });
                this.last_exit_status = 127;
                continue;
            }

            if (!stage.redir_out && is_last) {
                output.push(...result.stdout_buf);
            }
            if (!stage.redir_err) output.push(...result.stderr_buf);
            if (is_last) this.last_exit_status = result.exit_code;
        }
        return output;
    }

    _execute_pipeline_line(line) {
        line = this._expand_alias(line);
        const subshell = this._unwrap_command_group(line, '(', ')');
        if (subshell !== null) return this._execute_subshell(subshell);
        const group = this._unwrap_command_group(line, '{', '}');
        if (group !== null) {
            const command = group.replace(/;\s*$/, '');
            return this.execute(command, {record_history: false});
        }

        let pipeline;
        try {
            pipeline = this._parse_pipeline(line);
        } catch (e) {
            this.last_exit_status = 2;
            return [{text: `bash: ${e.message}`, tone: 'error'}];
        }
        let input_fd = null;
        let all_output = [];
        const close_fd = fd => {
            if (Number.isInteger(fd))
                ksyms.syscall(this._pid, ksyms.nr.__NR_close, fd);
        };
        const read_fd = fd => {
            const result = ksyms.syscall(
                this._pid, ksyms.nr.__NR_read, fd);
            return result.err ? '' : result.val;
        };
        const write_buffer = (fd, buffer) => {
            const value = this._buffer_to_text(buffer);
            if (value !== '')
                ksyms.syscall(
                    this._pid, ksyms.nr.__NR_write, fd, value);
        };

        for (let stage = 0; stage < pipeline.length; stage++) {
            const {
                tokens,
                redir_out,
                redir_in,
                redir_append,
                redir_err,
                redir_err_append,
                here_string,
            } = pipeline[stage];
            if (!tokens.length) continue;
            const assignments = [];
            while (tokens[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/))
                assignments.push(tokens.shift());
            if (!tokens.length) {
                for (const assignment of assignments) {
                    const equals = assignment.indexOf('=');
                    ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_setenv,
                        assignment.slice(0, equals),
                        assignment.slice(equals + 1),
                    );
                }
                this.last_exit_status = 0;
                continue;
            }
            const [cmd, ...raw_argv] = tokens;
            const argv = raw_argv.flatMap(arg => this._expand_glob(arg));
            const is_last = stage === pipeline.length - 1;
            const next_pipe = is_last
                ? null
                : ksyms.syscall(this._pid, ksyms.nr.__NR_pipe).val;
            const pipe_stdout = Boolean(next_pipe && !redir_out);
            const output_flags = ksyms.types.O_WRONLY |
                ksyms.types.O_CREAT |
                (redir_append ? ksyms.types.O_APPEND : ksyms.types.O_TRUNC);
            const error_flags = ksyms.types.O_WRONLY |
                ksyms.types.O_CREAT |
                (redir_err_append
                    ? ksyms.types.O_APPEND
                    : ksyms.types.O_TRUNC);
            let output_fd = null;
            let error_fd = null;
            if (redir_out) {
                const opened = ksyms.syscall(
                    this._pid, ksyms.nr.__NR_open, redir_out, output_flags, 0o666);
                if (opened.err) {
                    close_fd(next_pipe?.[0]);
                    close_fd(next_pipe?.[1]);
                    all_output.push({
                        text: `bash: ${redir_out}: ${opened.err === -13 ? 'Permission denied' : 'Cannot create file'}`,
                        tone: 'error',
                    });
                    this.last_exit_status = 1;
                    break;
                }
                output_fd = opened.val;
            }
            if (redir_err) {
                const opened = ksyms.syscall(
                    this._pid, ksyms.nr.__NR_open, redir_err, error_flags, 0o666);
                if (opened.err) {
                    close_fd(output_fd);
                    close_fd(next_pipe?.[0]);
                    close_fd(next_pipe?.[1]);
                    all_output.push({
                        text: `bash: ${redir_err}: Cannot create file`,
                        tone: 'error',
                    });
                    this.last_exit_status = 1;
                    break;
                }
                error_fd = opened.val;
            }

            // Prepare standard input.
            let stage_input_fd = input_fd;
            let stdin_data = '';
            if (here_string !== null) {
                close_fd(stage_input_fd);
                const here_pipe = ksyms.syscall(
                    this._pid, ksyms.nr.__NR_pipe).val;
                ksyms.syscall(
                    this._pid,
                    ksyms.nr.__NR_write,
                    here_pipe[1],
                    here_string + '\n',
                );
                close_fd(here_pipe[1]);
                stage_input_fd = here_pipe[0];
            } else if (redir_in) {
                close_fd(stage_input_fd);
                const opened = ksyms.syscall(
                    this._pid,
                    ksyms.nr.__NR_open,
                    redir_in,
                    ksyms.types.O_RDONLY,
                );
                if (opened.err) {
                    close_fd(output_fd);
                    close_fd(error_fd);
                    close_fd(next_pipe?.[0]);
                    close_fd(next_pipe?.[1]);
                    all_output.push({
                        text: `bash: ${redir_in}: ${opened.err === -13 ? 'Permission denied' : 'No such file or directory'}`,
                        tone: 'error',
                    });
                    this.last_exit_status = 1;
                    break;
                }
                stage_input_fd = opened.val;
            }

            const builtin = this._is_shell_builtin(cmd);
            if (builtin && stage_input_fd !== null)
                stdin_data = read_fd(stage_input_fd);

            // Apply command-local environment assignments.
            const saved_env = {};
            for (const assignment of assignments) {
                const equals = assignment.indexOf('=');
                const key = assignment.slice(0, equals);
                const envp = this.envp;
                saved_env[key] = {
                    exists: Object.hasOwn(envp, key),
                    value: envp[key],
                };
                ksyms.syscall(
                    this._pid,
                    ksyms.nr.__NR_setenv,
                    key,
                    assignment.slice(equals + 1),
                );
            }

            const run_in_child = pipeline.length > 1;
            let exec_result = this._run_builtin_stage(
                cmd,
                argv,
                stdin_data,
                run_in_child,
            );
            let output_needs_pipe_copy = Boolean(exec_result);
            if (!exec_result) {
                const fd_map = {};
                const preserve_fds = [];
                const close_fds = [
                    stage_input_fd,
                    ...(next_pipe ?? []),
                    output_fd,
                    error_fd,
                ].filter(Number.isInteger);
                if (stage_input_fd !== null) {
                    fd_map[0] = stage_input_fd;
                    preserve_fds.push(0);
                }
                if (pipe_stdout) {
                    fd_map[1] = next_pipe[1];
                    preserve_fds.push(1);
                } else if (output_fd !== null) {
                    fd_map[1] = output_fd;
                    preserve_fds.push(1);
                }
                if (error_fd !== null) {
                    fd_map[2] = error_fd;
                    preserve_fds.push(2);
                }
                const result = do_execve(
                    this._pid, this.uid, this.gid, this.cwd,
                    [cmd, ...argv], stdin_data, 0,
                    {fd_map, close_fds, preserve_fds},
                );
                exec_result = result;
                output_needs_pipe_copy = false;
                if (exec_result?.errno === ENOEXEC) {
                    if (stage_input_fd !== null)
                        stdin_data = read_fd(stage_input_fd);
                    const fallback = this._run_shell_script(
                        exec_result.path,
                        argv,
                        stdin_data,
                    );
                    if (fallback) {
                        exec_result = fallback;
                        output_needs_pipe_copy = true;
                    }
                }
            }

            for (const [key, saved] of Object.entries(saved_env)) {
                if (saved.exists)
                    ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_setenv,
                        key,
                        saved.value,
                    );
                else
                    ksyms.syscall(
                        this._pid,
                        ksyms.nr.__NR_unsetenv,
                        key,
                    );
            }

            if (output_needs_pipe_copy && exec_result) {
                if (pipe_stdout)
                    write_buffer(next_pipe[1], exec_result.stdout_buf);
                else if (output_fd !== null)
                    write_buffer(output_fd, exec_result.stdout_buf);
                if (error_fd !== null)
                    write_buffer(error_fd, exec_result.stderr_buf);
            }
            close_fd(stage_input_fd);
            close_fd(next_pipe?.[1]);
            close_fd(output_fd);
            close_fd(error_fd);
            input_fd = next_pipe?.[0] ?? null;

            if (!exec_result) {
                close_fd(input_fd);
                input_fd = null;
                all_output.push({text: `bash: ${cmd}: command not found`, tone: 'error'});
                this.last_exit_status = 127;
                break;
            }

            const shell_session = exec_result.stdout_buf.find(item =>
                item?.type === 'control' &&
                item.action === 'shell-session');
            if (shell_session) {
                const child = ksyms.get_task(shell_session.pid);
                exec_result.stdout_buf.splice(
                    exec_result.stdout_buf.indexOf(shell_session),
                    1,
                );
                if (!child ||
                    ![
                        '/bin/bash',
                        '/bin/dash',
                        '/bin/sh',
                        '/usr/bin/bash',
                        '/usr/bin/dash',
                        '/usr/bin/sh',
                    ].includes(child.executable)) {
                    exec_result.stderr_buf.push({
                        text: 'bash: invalid child shell session',
                        tone: 'error',
                    });
                    exec_result.exit_code = 1;
                } else {
                    this._enter_shell_session(child.pid);
                }
            }

            this.last_exit_status = exec_result.exit_code;
            if (is_last && !redir_out)
                all_output.push(...exec_result.stdout_buf);
            if (!redir_err) all_output.push(...exec_result.stderr_buf);
            if (is_last && exec_result.stdout_buf.some(l => l.special === 'clear'))
                all_output = [{special: 'clear'}];
        }

        close_fd(input_fd);
        return all_output;
    }
}

Object.assign(Bash.prototype, bash_job_control_methods);
