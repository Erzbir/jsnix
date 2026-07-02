/**
 * drivers/tty/core.js - Renderer-independent terminal core
 *
 * The core owns login, shell sessions, history, completion, and TTY
 * events. It has no dependency on DOM APIs, CSS, HTML, or a browser.
 */

'use strict';

import {ksyms} from '../../kernel/ksyms.js';
import {ROOT_UID} from '../../kernel/include/types.js';
import {kernel_boot_time} from '../../kernel/syscall/dispatcher.js';
import {authenticate} from '../../kernel/security/credentials.js';
import {
    Bash,
    bash_tab_complete,
} from '../../usr/shell/bash.js';
import {
    tty_move_history,
    tty_replace_completion,
} from './line_discipline.js';
import {tty_editor_session} from './editor_session.js';

const MAX_LOGIN_FAILURES = 3;

export const DEFAULT_BOOT_BANNER = [
    '      _ ____  _   _ _       ',
    '     | / ___|| \\ | (_)_  __ ',
    '  _  | \\___ \\|  \\| | \\ \\/ / ',
    ' | |_| |___) | |\\  | |>  <  ',
    '  \\___/|____/|_| \\_|_/_/\\_\\ ',
];

function read_kernel_file(path) {
    const inode = ksyms.path_lookup(path);
    return inode?.i_type === 'file' ? String(inode.i_data ?? '') : null;
}

function current_hostname() {
    return read_kernel_file('/etc/hostname')?.trim() || 'jsnix';
}

function normalize_boot_banner(options) {
    const banner = options.banner;
    if (banner === false || banner === null) return [];
    const banner_file = options.banner_file;
    const source = banner_file
        ? read_kernel_file(banner_file) ?? ''
        : (banner === true || banner === undefined)
            ? read_kernel_file('/etc/issue') ?? DEFAULT_BOOT_BANNER
            : banner;
    if (source === '') return [];
    const lines = typeof source === 'string'
        ? source.replace(/\n$/, '').split(/\r?\n/)
        : Array.isArray(source)
            ? source
            : [source];
    return lines.map(line => {
        if (typeof line === 'string')
            return {type: 'line', text: line, tone: 'banner'};
        return {
            type: 'line',
            text: String(line?.text ?? ''),
            tone: line?.tone ?? 'banner',
        };
    });
}

function normalize_login_banner() {
    const source = read_kernel_file('/etc/motd');
    if (!source?.trim()) return [];
    return source.replace(/\n$/, '').split(/\r?\n/).map(text => ({
        type: 'line',
        text,
        tone: 'muted',
    }));
}

function common_prefix(values) {
    if (!values.length) return '';
    let prefix = values[0];
    for (const value of values.slice(1)) {
        while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
        if (!prefix) break;
    }
    return prefix;
}

function format_columns(values, width = 80) {
    const items = [...values].sort();
    if (!items.length) return [];
    const column_width = Math.min(
        32,
        Math.max(...items.map(item => item.length)) + 2,
    );
    const columns = Math.max(1, Math.floor(width / column_width));
    const rows = Math.ceil(items.length / columns);
    const lines = [];

    for (let row = 0; row < rows; row++) {
        let line = '';
        for (let column = 0; column < columns; column++) {
            const index = column * rows + row;
            if (index >= items.length) continue;
            const item = items[index];
            line += column === columns - 1
                ? item
                : item.padEnd(column_width);
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

function normalize_output(item) {
    if (item?.type === 'control') return item;
    const output = {
        type: 'line',
        text: String(item?.text ?? ''),
        tone: item?.tone ?? 'normal',
    };
    if (Array.isArray(item?.segments)) {
        output.segments = item.segments.map(segment => ({
            text: String(segment?.text ?? ''),
            role: segment?.role ?? 'normal',
        }));
    }
    return output;
}

export class tty_core {
    constructor(options = {}) {
        this.options = {
            login: options.login ?? false,
            uid: options.uid ?? ROOT_UID,
            env: options.env ?? {},
            banner: options.banner === undefined ? true : options.banner,
            banner_file: options.banner_file,
            respawn_delay: options.respawn_delay ?? 800,
            max_login_failures:
                options.max_login_failures ??
                MAX_LOGIN_FAILURES,
        };
        this.listeners = new Map();
        this.shell = null;
        this.started = false;
        this.destroyed = false;
        this.loginState = 'idle';
        this.loginUsername = '';
        this.loginFailures = 0;
        this.powerState = {state: 'running', action: null};
        this.historyState = {
            hist_idx: 0,
            hist_draft: '',
        };
        this.tickTimer = null;
        this.foreground = null;
        this.editor = null;
        this.editor_pid = null;
        this.editor_exit_key = null;
    }

    on(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
        return () => this.listeners.get(type)?.delete(listener);
    }

    emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) listener(payload);
        for (const listener of this.listeners.get('*') ?? [])
            listener({type, payload});
    }

    start() {
        if (this.started || this.destroyed) return this;
        this.started = true;
        this._emit_boot();
        if (this.options.login) this._begin_login();
        else this._start_session(this.options.uid);
        this._emit_state();
        this.tickTimer = setInterval(() => this._emit_state(), 1000);
        return this;
    }

    submit(value) {
        if (this.destroyed) return;
        const line = String(value ?? '');
        if (this.loginState === 'username') {
            this._submit_username(line.trim());
            return;
        }
        if (this.loginState === 'password') {
            this._submit_password(line);
            return;
        }
        if (this.editor) return;
        if (!this.shell?.is_alive || this.foreground) return;

        this.emit('echo', {
            prompt: this.prompt,
            text: line,
        });
        this.emit('input', {value: '', cursor: 0, secure: false});
        const result = this.shell.execute_interactive(line);
        const finish = output => {
            if (this.destroyed) return;
            this.foreground = null;
            this._emit_output(output);
            if (this.editor) {
                this._emit_state();
                return;
            }
            if (this._handle_power_state()) return;
            this.historyState.hist_idx = this.shell?.history.length ?? 0;
            this.historyState.hist_draft = '';
            this._emit_prompt();
            this._emit_state();
        };
        if (result && typeof result.then === 'function') {
            this.foreground = result;
            result
                .then(finish)
                .catch(error => finish([{
                    text: `bash: ${error.message}`,
                    tone: 'error',
                }]));
            return;
        }
        finish(result);
    }

    handleKey(key, context = {}) {
        if (this.destroyed) return;
        if (this.powerState.state !== 'running') return;
        if (this.editor) {
            this._handle_editor_key(key);
            return;
        }
        const value = String(context.value ?? '');
        const cursor = context.cursor ?? value.length;

        if (context.ctrlKey && key.toLowerCase() === 'l') {
            this.emit('clear');
            return;
        }
        if (context.ctrlKey && key.toLowerCase() === 'c' &&
            this.shell?.is_alive) {
            if (this.foreground && this.shell.foreground_pid) {
                ksyms.syscall(
                    this.shell.pid,
                    ksyms.nr.__NR_kill,
                    this.shell.foreground_pgid
                        ? -this.shell.foreground_pgid
                        : this.shell.foreground_pid,
                    ksyms.types.SIGINT,
                );
            }
            this.emit('echo', {
                prompt: this.prompt,
                text: value + '^C',
            });
            this.historyState.hist_idx = this.shell.history.length;
            this.historyState.hist_draft = '';
            this.emit('input', {value: '', cursor: 0, secure: false});
            if (!this.foreground) this._emit_prompt();
            return;
        }
        if (!this.shell?.is_alive || this.foreground) return;

        if (key === 'ArrowUp' || key === 'ArrowDown') {
            const next = tty_move_history(
                this.shell.history,
                this.historyState,
                key === 'ArrowUp' ? -1 : 1,
                value,
            );
            this.emit('input', {
                value: next,
                cursor: next.length,
                secure: false,
            });
            return;
        }
        if (key === 'Tab') {
            const completions = bash_tab_complete(
                this.shell,
                value.slice(0, cursor),
            );
            if (completions.length === 0) return;
            if (completions.length === 1) {
                const result = tty_replace_completion(
                    value,
                    cursor,
                    completions[0],
                );
                this.emit('input', {...result, secure: false});
                return;
            }

            const prefix = common_prefix(completions);
            const partial = tty_replace_completion(value, cursor, prefix);
            if (prefix && partial.value !== value) {
                this.emit('input', {...partial, secure: false});
                return;
            }

            this._emit_output(format_columns(completions).map(text => ({
                text,
                tone: 'normal',
            })));
        }
    }

    write(value) {
        this.submit(value);
    }

    get prompt() {
        if (this.loginState === 'username')
            return {kind: 'login', label: `${current_hostname()} login:`};
        if (this.loginState === 'password')
            return {kind: 'password', label: 'Password:'};
        if (this.powerState.state !== 'running') {
            const label = this.powerState.state === 'panic'
                ? '[panic]'
                : this.powerState.action === 'restart'
                    ? '[rebooting]'
                    : '[poweroff]';
            return {kind: 'dead', label};
        }
        if (this.editor) return {kind: 'app', label: ''};
        if (!this.shell?.is_alive) return {kind: 'dead', label: '[dead]'};
        const home = this.shell.home;
        const cwd = this.shell.cwd;
        return {
            kind: 'shell',
            user: this.shell.username,
            hostname: current_hostname(),
            cwd,
            displayCwd: cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd,
            symbol: this.shell.uid === ROOT_UID ? '#' : '$',
            root: this.shell.uid === ROOT_UID,
        };
    }

    get state() {
        const processes = [];
        ksyms.for_each_task(task => processes.push({
            pid: task.pid,
            comm: task.comm,
            state: task.state,
            uid: task.uid,
        }));
        return {
            alive: Boolean(this.shell?.is_alive),
            pid: this.editor_pid ?? this.shell?.pid ?? null,
            exitStatus: this.shell?.last_exit_status ?? 0,
            user: this.shell?.username ?? null,
            uid: this.shell?.uid ?? null,
            cwd: this.shell?.cwd ?? null,
            prompt: this.prompt,
            uptime: Math.floor((Date.now() - kernel_boot_time) / 1000),
            processes,
            power: {...this.powerState},
            application: this.editor
                ? {
                    kind: 'editor',
                    pid: this.editor_pid,
                    editor: this.editor.editor,
                    path: this.editor.path,
                    mode: this.editor.mode,
                    dirty: this.editor.dirty,
                }
                : null,
        };
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearInterval(this.tickTimer);
        if (this.shell?.foreground_pid) {
            ksyms.syscall(
                this.shell.pid,
                ksyms.nr.__NR_kill,
                this.shell.foreground_pid,
                ksyms.types.SIGTERM,
            );
            this.shell.foreground_pid = null;
        }
        this._release_editor_process(0);
        if (this.shell?.is_alive) {
            ksyms.unregister_exit_handler(this.shell.pid, 'tty_respawn');
            ksyms.syscall(this.shell.pid, ksyms.nr.__NR_exit, 0);
        }
        this.listeners.clear();
    }

    _emit_boot() {
        for (const line of normalize_boot_banner(this.options))
            this.emit('output', line);
        const lines = [
            ['JSNix Kernel 0.1.0 (js-x64)', 'kernel'],
            [`Boot: ${new Date(kernel_boot_time).toISOString()}`, 'muted'],
            ['[    0.000000] VFS: mounted root (jsfs) readonly', 'system'],
            ['[    0.010000] populate_rootfs: users + files ready', 'system'],
            ['[    0.020000] tty: pts/0 ready', 'system'],
            ['', 'normal'],
            ['JSNix 0.1.0  (pts/0)', 'success'],
            ['', 'normal'],
        ];
        if (!this.options.login) {
            lines.push([
                'Type "help" for commands.',
                'info',
            ]);
            lines.push(['', 'normal']);
        }
        for (const [text, tone] of lines)
            this.emit('output', {type: 'line', text, tone});
    }

    _begin_login() {
        this.shell = null;
        this.loginState = 'username';
        this.loginUsername = '';
        this.emit('input', {value: '', cursor: 0, secure: false});
        this._emit_prompt();
    }

    _submit_username(username) {
        if (!username) return;
        this.emit('output', {
            type: 'line',
            text: `${current_hostname()} login: ${username}`,
            tone: 'muted',
        });
        this.loginUsername = username;
        this.loginState = 'password';
        this.emit('input', {value: '', cursor: 0, secure: true});
        this._emit_prompt();
    }

    _submit_password(password) {
        const entry = authenticate(this.loginUsername, password);
        this.emit('input', {value: '', cursor: 0, secure: false});
        if (entry) {
            this.loginState = 'idle';
            this.emit('output', {type: 'line', text: '', tone: 'muted'});
            this.emit('output', {
                type: 'line',
                text: `Last login: ${new Date().toString()} on pts/0`,
                tone: 'muted',
            });
            for (const line of normalize_login_banner())
                this.emit('output', line);
            this.emit('output', {type: 'line', text: '', tone: 'muted'});
            this._start_session(entry.uid);
            return;
        }

        this.loginFailures++;
        this.emit('output', {
            type: 'line',
            text: 'Login incorrect',
            tone: 'error',
        });
        if (this.loginFailures >= this.options.max_login_failures) {
            this.loginState = 'locked';
            this.emit('output', {type: 'line', text: '', tone: 'muted'});
            this.emit('output', {
                type: 'line',
                text:
                    'Maximum authentication failures ' +
                    `(${this.options.max_login_failures}). Connection closed.`,
                tone: 'error',
            });
            this.emit('prompt', {kind: 'dead', label: ''});
            this.emit('lockout');
            return;
        }
        this._begin_login();
    }

    _start_session(uid) {
        const account = ksyms.getpwuid(uid);
        this.shell = new Bash(uid, account?.gid ?? 0, {
            history: [],
            on_job_output: (_job, output) => {
                this._emit_output(output);
                this._emit_prompt();
                this._emit_state();
            },
        });
        this._apply_env();
        this.loginState = 'idle';
        this.historyState.hist_idx = this.shell.history.length;
        this.historyState.hist_draft = '';
        this._emit_prompt();
        this._emit_state();

        ksyms.register_exit_handler(
            this.shell.pid,
            'tty_respawn',
            (dead_pid, code) => {
                const login_session = this.options.login;
                this.emit('output', {type: 'line', text: '', tone: 'muted'});
                this.emit('output', {
                    type: 'line',
                    text: `bash: pid ${dead_pid} killed (exit ${code}) - ` +
                        (login_session
                            ? 'returning to login'
                            : 'session ended'),
                    tone: 'warning',
                });
                this.shell = null;
                this.foreground = null;
                this._emit_prompt();
                if (!login_session) {
                    this._emit_state();
                    return;
                }
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.emit('output', {type: 'line', text: '', tone: 'muted'});
                    this.emit('output', {
                        type: 'line',
                        text: 'login: session ended - please log in again',
                        tone: 'system',
                    });
                    this._begin_login();
                    this._emit_state();
                }, this.options.respawn_delay);
            },
        );
    }

    _apply_env() {
        ksyms.syscall(
            this.shell.pid,
            ksyms.nr.__NR_setenv,
            'HOSTNAME',
            current_hostname(),
        );
        for (const [key, value] of Object.entries(this.options.env ?? {})) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
            ksyms.syscall(
                this.shell.pid,
                ksyms.nr.__NR_setenv,
                key,
                String(value),
            );
        }
    }

    _emit_output(items) {
        for (const item of items) {
            const output = normalize_output(item);
            if (output.type === 'control' && output.action === 'clear')
                this.emit('clear');
            else if (output.type === 'control' &&
                output.action === 'editor-session')
                this._start_editor_session(output);
            else
                this.emit('output', output);
        }
    }

    _start_editor_session(payload) {
        const pid = Number(payload.pid);
        this.editor = new tty_editor_session({
            editor: payload.editor,
            path: payload.path,
            content: payload.content,
            readonly: payload.readonly,
        });
        this.editor_pid = Number.isInteger(pid) ? pid : null;
        this.editor_exit_key = this.editor_pid
            ? `tty_editor_${this.editor_pid}`
            : null;
        if (this.editor_pid) {
            ksyms.set_task_state(this.editor_pid, ksyms.types.TASK_SLEEPING);
            ksyms.register_exit_handler(
                this.editor_pid,
                this.editor_exit_key,
                () => this._force_end_editor_session(),
            );
        }
        this.emit('input', {value: '', cursor: 0, secure: false, raw: true});
        this.emit('prompt', this.prompt);
        this._emit_editor_screen();
    }

    _handle_editor_key(key) {
        if (this.editor_pid)
            ksyms.set_task_state(this.editor_pid, ksyms.types.TASK_RUNNING);
        const result = this.editor.handle_key(key);
        if (result.write) {
            const written = ksyms.syscall(
                this.editor_pid ?? this.shell.pid,
                ksyms.nr.__NR_writefile,
                result.write.path,
                result.write.content,
                false,
            );
            if (written.err) {
                const message = written.err === -13
                    ? 'Permission denied'
                    : 'Cannot write file';
                this.editor.apply_write_error(result.write.path, message);
            } else {
                this.editor.apply_write(result.write.path);
                if (result.exit_after_write) result.exit = true;
            }
        }
        if (result.exit) {
            this._end_editor_session();
            return;
        }
        if (this.editor_pid)
            ksyms.set_task_state(this.editor_pid, ksyms.types.TASK_SLEEPING);
        this._emit_editor_screen();
    }

    _emit_editor_screen() {
        if (!this.editor) return;
        this.emit('app-screen', this.editor.screen());
        this.emit('state', this.state);
    }

    _end_editor_session() {
        const screen = this.editor?.screen();
        this.editor = null;
        this._release_editor_process(0);
        this.emit('app-exit', screen ?? {type: 'editor-screen'});
        this.emit('input', {value: '', cursor: 0, secure: false, raw: false});
        this._emit_prompt();
        this._emit_state();
    }

    _force_end_editor_session() {
        if (!this.editor) return;
        const screen = this.editor.screen();
        this.editor = null;
        this.editor_pid = null;
        this.editor_exit_key = null;
        this.emit('app-exit', screen);
        this.emit('input', {value: '', cursor: 0, secure: false, raw: false});
        this._emit_prompt();
        this._emit_state();
    }

    _release_editor_process(exit_code) {
        const pid = this.editor_pid;
        const key = this.editor_exit_key;
        this.editor_pid = null;
        this.editor_exit_key = null;
        if (!pid) return;
        if (key) ksyms.unregister_exit_handler(pid, key);
        const task = ksyms.get_task(pid);
        if (task && task.state !== ksyms.types.TASK_ZOMBIE)
            ksyms.syscall(pid, ksyms.nr.__NR_exit, exit_code);
    }

    _handle_power_state() {
        const power = ksyms.power_state();
        if (power.state === 'running') return false;

        this.powerState = power;
        if (this.shell?.is_alive) {
            ksyms.unregister_exit_handler(this.shell.pid, 'tty_respawn');
            ksyms.syscall(this.shell.pid, ksyms.nr.__NR_exit, 0);
        }
        this.shell = null;
        this.loginState = 'poweroff';
        this.emit('input', {value: '', cursor: 0, secure: false});
        this.emit('prompt', this.prompt);
        this.emit('power', {...power});
        this._emit_state();
        return true;
    }

    _emit_prompt() {
        this.emit('prompt', this.prompt);
    }

    _emit_state() {
        this.emit('state', this.state);
    }
}

export function create_tty(options) {
    return new tty_core(options);
}
