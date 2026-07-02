/**
 * apps/terminal/dom_terminal.js - Browser renderer for the terminal app
 *
 * This module owns DOM construction and presentation classes. tty_core
 * remains usable without this renderer or any browser APIs.
 */

'use strict';

import {ROOT_UID} from '../../src/kernel/include/types.js';
import {
    DOM_TERMINAL_CSS,
    DOM_TERMINAL_STYLE_ID,
} from './dom_terminal_style.js';

function create_element(tag, class_name, text) {
    const element = document.createElement(tag);
    if (class_name) element.className = class_name;
    if (text !== undefined) element.textContent = String(text);
    return element;
}

function class_token(value, fallback = 'normal') {
    const token = String(value ?? fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return token || fallback;
}

export function ensureDOMTerminalStyle(options = {}) {
    if (typeof document === 'undefined' || options.style === false) return null;
    const id = options.styleId ?? DOM_TERMINAL_STYLE_ID;
    let style = document.getElementById(id);
    if (style) return style;

    style = document.createElement('style');
    style.id = id;
    style.textContent = typeof options.style === 'string'
        ? options.style
        : DOM_TERMINAL_CSS;
    document.head.appendChild(style);
    return style;
}

function format_uptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function append_prompt(parent, prompt) {
    parent.replaceChildren();
    if (!prompt || prompt.kind === 'dead') {
        parent.appendChild(create_element(
            'span',
            'tty-prompt-dead',
            prompt?.label ?? '[dead]',
        ));
        return;
    }
    if (prompt.kind === 'login' || prompt.kind === 'password') {
        parent.appendChild(create_element(
            'span',
            `tty-prompt-${prompt.kind}`,
            prompt.label,
        ));
        parent.append(' ');
        return;
    }

    parent.appendChild(create_element('span', 'tty-prompt-user', prompt.user));
    parent.appendChild(create_element('span', 'tty-prompt-at', '@'));
    parent.appendChild(create_element(
        'span',
        'tty-prompt-host',
        prompt.hostname,
    ));
    parent.appendChild(create_element('span', 'tty-prompt-colon', ':'));
    parent.appendChild(create_element(
        'span',
        'tty-prompt-path',
        prompt.displayCwd,
    ));
    parent.appendChild(create_element(
        'span',
        prompt.root ? 'tty-prompt-root' : 'tty-prompt-dollar',
        ` ${prompt.symbol}`,
    ));
    parent.append(' ');
}

export class DOMTerminalRenderer {
    constructor(container, tty, options = {}) {
        if (!(container instanceof HTMLElement))
            throw new TypeError('DOMTerminalRenderer: container must be HTMLElement');
        this.container = container;
        this.tty = tty;
        this.options = {
            height: options.height ?? '600px',
            sidebar: options.sidebar ?? true,
            autoStart: options.autoStart ?? true,
            style: options.style ?? true,
            styleId: options.styleId,
        };
        this.unsubscribers = [];
        this.root = null;
        this.input = null;
        this.output = null;
        this.prompt = null;
        this.sidebar = {};
        this.appActive = false;
        this.appOutputSnapshot = null;
    }

    mount() {
        if (this.root) return this;
        ensureDOMTerminalStyle(this.options);
        this._build_dom();
        this._bind_tty();
        if (this.options.autoStart) this.tty.start();
        return this;
    }

    destroy() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.tty.destroy();
        this.root?.remove();
        this.root = null;
    }

    focus() {
        this.input?.focus();
    }

    _build_dom() {
        const root = create_element('div', 'jsnix-tty');
        root.style.height = this.options.height;

        const titlebar = create_element('div', 'tty-titlebar');
        const dots = create_element('div', 'tty-tb-dots');
        for (const color of ['red', 'yellow', 'green'])
            dots.appendChild(create_element('div', `tty-tb-dot ${color}`));
        titlebar.appendChild(dots);
        titlebar.appendChild(create_element(
            'div',
            'tty-tb-title',
            'JSNix 0.1.0 - pts/0',
        ));
        const clock = create_element('div', 'tty-tb-clock');
        titlebar.appendChild(clock);
        root.appendChild(titlebar);

        const body = create_element('div', 'tty-body');
        root.appendChild(body);
        if (this.options.sidebar) body.appendChild(this._build_sidebar());

        const terminal_area = create_element('div', 'tty-term-area');
        this.output = create_element('div', 'tty-output');
        terminal_area.appendChild(this.output);

        const input_bar = create_element('div', 'tty-input-bar');
        this.prompt = create_element('div', 'tty-prompt');
        this.input = create_element('input', 'tty-cmd-input');
        this.input.type = 'text';
        this.input.name = 'jsnix-terminal-command';
        this.input.autocomplete = 'off';
        this.input.autocapitalize = 'off';
        this.input.autocorrect = 'off';
        this.input.inputMode = 'text';
        this.input.spellcheck = false;
        this.input.readOnly = true;
        this.input.setAttribute('aria-autocomplete', 'none');
        this.input.setAttribute('data-1p-ignore', 'true');
        this.input.setAttribute('data-lpignore', 'true');
        this.input.setAttribute('data-form-type', 'other');
        this.input.addEventListener('focus', () => {
            if (!this.appActive) this.input.readOnly = false;
        });
        input_bar.append(this.prompt, this.input);
        terminal_area.appendChild(input_bar);
        body.appendChild(terminal_area);

        const statusbar = create_element('div', 'tty-statusbar');
        const running = create_element('div', 'tty-chip');
        running.append(
            create_element('div', 'dot'),
            create_element('span', '', 'RUNNING'),
        );
        this.sidebar.pid = create_element('span', 'tty-status-pid', '-');
        this.sidebar.exitStatus =
            create_element('span', 'tty-status-exit', '0');
        this.sidebar.clock = create_element('span', 'tty-status-clock');
        statusbar.append(
            running,
            document.createTextNode('PID '),
            this.sidebar.pid,
            document.createTextNode('$? '),
            this.sidebar.exitStatus,
            this.sidebar.clock,
        );
        root.appendChild(statusbar);

        this.input.addEventListener('keydown', event => {
            if (this.appActive) {
                event.preventDefault();
                this.tty.handleKey(event.key, {
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                });
                this.input.value = '';
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                this.tty.submit(this.input.value);
                return;
            }
            if (['ArrowUp', 'ArrowDown', 'Tab'].includes(event.key) ||
                (event.ctrlKey && ['c', 'l'].includes(event.key.toLowerCase()))) {
                event.preventDefault();
                this.tty.handleKey(event.key, {
                    value: this.input.value,
                    cursor: this.input.selectionStart ?? this.input.value.length,
                    ctrlKey: event.ctrlKey,
                });
            }
        });
        terminal_area.addEventListener('click', () => this.focus());

        this.container.appendChild(root);
        this.root = root;
        this.sidebar.titleClock = clock;
    }

    _build_sidebar() {
        const sidebar = create_element('div', 'tty-sidebar');
        const system = create_element('div', 'tty-sb-section');
        system.append(
            create_element('div', 'tty-sb-title', 'sysinfo'),
            this._sidebar_row('kernel', '0.1.0-jsnix'),
            this._sidebar_row('arch', 'js-x64'),
        );
        const uptime_row = this._sidebar_row('uptime', '0s');
        this.sidebar.uptime = uptime_row.querySelector('.tty-sb-val');
        system.appendChild(uptime_row);

        const session = create_element('div', 'tty-sb-section');
        session.appendChild(create_element('div', 'tty-sb-title', 'session'));
        const user_row = this._sidebar_row('user', '-');
        const uid_row = this._sidebar_row('uid', '-');
        const cwd_row = this._sidebar_row('cwd', '-');
        this.sidebar.user = user_row.querySelector('.tty-sb-val');
        this.sidebar.uid = uid_row.querySelector('.tty-sb-val');
        this.sidebar.cwd = cwd_row.querySelector('.tty-sb-val');
        session.append(user_row, uid_row, cwd_row);

        sidebar.append(system, session);
        sidebar.appendChild(create_element(
            'div',
            'tty-sb-section tty-sb-title',
            '/proc',
        ));
        this.sidebar.processes = create_element('div', 'tty-proc-list');
        sidebar.appendChild(this.sidebar.processes);
        return sidebar;
    }

    _sidebar_row(key, value) {
        const row = create_element('div', 'tty-sb-row');
        row.append(
            create_element('span', 'tty-sb-key', key),
            create_element('span', 'tty-sb-val', value),
        );
        return row;
    }

    _bind_tty() {
        this.unsubscribers.push(
            this.tty.on('output', item => this._append_output(item)),
            this.tty.on('echo', item => this._append_echo(item)),
            this.tty.on('clear', () => this.output.replaceChildren()),
            this.tty.on('prompt', prompt => append_prompt(this.prompt, prompt)),
            this.tty.on('input', state => this._set_input(state)),
            this.tty.on('app-screen', screen => this._render_app_screen(screen)),
            this.tty.on('app-exit', () => this._exit_app_screen()),
            this.tty.on('state', state => this._render_state(state)),
            this.tty.on('power', state => this._render_power(state)),
            this.tty.on('lockout', () => {
                this.input.disabled = true;
            }),
        );
    }

    _append_output(item) {
        if (this.appActive) this._exit_app_screen();
        const line = create_element(
            'span',
            `tty-line tty-tone-${item.tone ?? 'normal'}`,
        );
        if (Array.isArray(item.segments)) {
            for (const segment of item.segments) {
                line.appendChild(create_element(
                    'span',
                    `tty-file-${segment.role ?? 'normal'}`,
                    segment.text ?? '',
                ));
            }
        } else {
            line.textContent = item.text ?? '';
        }
        this.output.appendChild(line);
        this._scroll_bottom();
    }

    _append_echo(item) {
        const line = create_element('span', 'tty-line tty-echo');
        const prompt = create_element('span', 'tty-echo-prompt');
        append_prompt(prompt, item.prompt);
        line.append(prompt, create_element(
            'span',
            'tty-echo-command',
            item.text,
        ));
        this.output.appendChild(line);
        this._scroll_bottom();
    }

    _set_input(state) {
        if (this.input.disabled) return;
        const raw = Boolean(state.raw);
        this.input.readOnly = raw;
        this.input.value = raw ? '' : (state.value ?? '');
        this.input.type = state.secure ? 'password' : 'text';
        this.input.disabled = false;
        const cursor = raw ? 0 : (state.cursor ?? this.input.value.length);
        this.input.setSelectionRange(cursor, cursor);
        this.focus();
    }

    _render_app_screen(screen) {
        const entering = !this.appActive;
        this.appActive = true;
        this.root?.classList.add('tty-app-active');
        if (this.root) this.root.dataset.appMode = screen.mode ?? 'normal';
        if (entering) {
            this.appOutputSnapshot = document.createDocumentFragment();
            this.appOutputSnapshot.append(...this.output.childNodes);
        }
        this.output.replaceChildren();
        this.output.setAttribute('aria-label', `${screen.editor ?? 'editor'} screen`);

        const mode = class_token(screen.mode);
        const wrap = create_element(
            'div',
            `tty-editor-screen tty-editor-mode-${mode}`,
        );
        wrap.dataset.editor = screen.editor ?? 'editor';
        wrap.dataset.mode = screen.mode ?? 'normal';

        const body = create_element('div', 'tty-editor-body');
        for (const row of screen.rows ?? []) {
            const line = create_element('div', 'tty-editor-row');
            const number = row.number === null
                ? '    '
                : String(row.number).padStart(4);
            line.appendChild(create_element('span', 'tty-editor-line-no', number));
            const text = row.text ?? '';
            if (row.cursor === null) {
                line.appendChild(create_element('span', 'tty-editor-text', text));
            } else {
                const cursor = Math.max(0, row.cursor);
                line.appendChild(create_element(
                    'span',
                    'tty-editor-text',
                    text.slice(0, cursor),
                ));
                line.appendChild(create_element(
                    'span',
                    'tty-editor-cursor',
                    text[cursor] ?? ' ',
                ));
                line.appendChild(create_element(
                    'span',
                    'tty-editor-text',
                    text.slice(cursor + 1),
                ));
            }
            body.appendChild(line);
        }

        const status = create_element('div', 'tty-editor-status');
        status.appendChild(create_element(
            'span',
            'tty-editor-status-main',
            screen.status ?? '',
        ));
        status.appendChild(create_element(
            'span',
            'tty-editor-status-help',
            'Esc normal | i insert | :wq save and quit',
        ));

        wrap.append(body, status);
        this.output.appendChild(wrap);
        this.input.value = '';
        this.input.readOnly = true;
        this.focus();
    }

    _exit_app_screen() {
        if (!this.appActive) return;
        this.appActive = false;
        this.root?.classList.remove('tty-app-active');
        if (this.root) delete this.root.dataset.appMode;
        this.output.removeAttribute('aria-label');
        this.output.replaceChildren();
        if (this.appOutputSnapshot)
            this.output.appendChild(this.appOutputSnapshot);
        this.appOutputSnapshot = null;
        this._scroll_bottom();
    }

    _render_power(state) {
        this.input.value = '';
        this.input.disabled = true;
        this.input.readOnly = true;
        this._append_output({
            text: state.action === 'restart'
                ? 'System is rebooting.'
                : 'System halted.',
            tone: 'warning',
        });
    }

    _render_state(state) {
        const now = new Date().toLocaleTimeString();
        this.sidebar.titleClock.textContent = now;
        this.sidebar.clock.textContent = now;
        this.sidebar.pid.textContent = state.pid ?? '-';
        this.sidebar.exitStatus.textContent = state.exitStatus;
        if (!this.options.sidebar) return;
        this.sidebar.uptime.textContent = format_uptime(state.uptime);
        this.sidebar.user.textContent = state.user ?? '-';
        this.sidebar.uid.textContent = state.uid ?? '-';
        this.sidebar.cwd.textContent =
            state.prompt?.displayCwd ?? state.cwd ?? '-';
        this.sidebar.user.classList.toggle('root', state.uid === ROOT_UID);
        this.sidebar.processes.replaceChildren();
        for (const process of state.processes) {
            const item = create_element('div', 'tty-proc-item');
            item.append(
                create_element('span', 'pid', process.pid),
                create_element('span', 'comm', process.comm),
                create_element('span', 'state', process.state),
            );
            this.sidebar.processes.appendChild(item);
        }
    }

    _scroll_bottom() {
        this.output.scrollTop = this.output.scrollHeight;
    }
}

export function mountDOMTerminal(container, tty, options) {
    return new DOMTerminalRenderer(container, tty, options).mount();
}
