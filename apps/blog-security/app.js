import {default_kernel} from '../../src/jsnix.js';
import {BLOG_SECURITY_CHALLENGE} from './challenge/config.js';
import {initChallenge} from './challenge/init.js';

const BASE = Object.freeze({
    hook: 'terminal-banner',
    title: 'Blog Security',
    subtitle: 'Hack Logon',
    github: 'https://github.com/Erzbir/jsnix',
});

const CHALLENGE = BLOG_SECURITY_CHALLENGE;
const LOGIN_CHECK_CONFIG = Object.freeze({
    spinner_ticks: configInteger(
        CHALLENGE.ui?.login_check?.spinner_ticks,
        12,
    ),
    spinner_delay_ms: configNumber(
        CHALLENGE.ui?.login_check?.spinner_delay_ms,
        35,
    ),
    reduced_motion_spinner_ticks: configInteger(
        CHALLENGE.ui?.login_check?.reduced_motion_spinner_ticks,
        1,
    ),
    reduced_motion_spinner_delay_ms: configNumber(
        CHALLENGE.ui?.login_check?.reduced_motion_spinner_delay_ms,
        0,
    ),
});

const STYLE = Object.freeze({
    print: '#d5d7d8',
    input: '#98c379',
    output: '#61afef',
    cyan: '#56b6c2',
    blue: '#61afef',
    magenta: '#c678dd',
    warn: '#efc261',
    error: '#ef6161',
    muted: '#8b949e',
    prompt: '#98c379',
    root: '#ef6161',
    spinner: ['|', '/', '-', '\\'],
});

const TEMPLATES = Object.freeze({
    sysInfo: `Blog Security Interface Version 3.0.0 from ${BASE.github}`,
    envCheck: `[+] Initializing Security Grid...
[{{LOADING}}] OS Integrity
[{{LOADING}}] Kernel Module
[{{LOADING}}] Access Control
[{{LOADING}}] IDS/IPS
[{{LOADING}}] Encryption
[{{LOADING}}] Log Auditing
[{{LOADING}}] Security Policy Loader
[{{LOADING}}] System check completed. No critical issues detected.
[+] Monitoring activated...`,
    accessDenied: `> access {{USER}}
Verifying credentials...
access: PERMISSION DENIED.
{{HINT}}`,
    accessSuccess: `> access {{USER}}
Verifying credentials...
access: SUCCESS
Is the flag here?
Blog System 3.0.0 #1 SMP PREEMPT_DYNAMIC Sat May 10 15:30:58 CST 2025 x86_64
Last login: {{TIME}} from {{IP}}`,
});

const APP_BOOT_OPTIONS = Object.freeze({
    hostname: 'blog-security',
    issue: '',
});

const SELECTORS = Object.freeze({
    output: '.output-content',
    subtitle: '.terminal-subtitle',
    loginForm: '.terminal-logon',
    username: '.username',
    password: '.password',
    ok: '.ok-btn',
    commandRow: '.command-container',
    commandPrompt: '.command-prompt',
    commandInput: '.command-input',
});

const CONTROL_KEYS = new Set(['c', 'l']);
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown']);
const REBOOT_DELAY_MS = 450;

const state = {
    tty: null,
    prompt: '',
    loginPending: false,
    loginFailures: 0,
    loginAttemptPassword: '',
    locked: false,
    sessionReady: false,
    appRaw: false,
    appOutputSnapshot: null,
};

function $(root, selector) {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`missing Blog Security element: ${selector}`);
    return element;
}

function prefersReducedMotion() {
    return typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function configNumber(value, fallback, min = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min ? number : fallback;
}

function configInteger(value, fallback, min = 0) {
    return Math.floor(configNumber(value, fallback, min));
}

function renderTemplate(template, data) {
    return template.replace(/{{\s*(\w+)\s*}}/g, (value, key) =>
        data[key] ?? value);
}

function randomIp() {
    return `192.168.${Math.floor(Math.random() * 200) + 1}.` +
        `${Math.floor(Math.random() * 200) + 20}`;
}

function passwordCharset(password) {
    const parts = [];
    if (/[a-z]/.test(password)) parts.push('lowercase letters');
    if (/[A-Z]/.test(password)) parts.push('uppercase letters');
    if (/\d/.test(password)) parts.push('digits');
    if (/[^A-Za-z0-9]/.test(password)) parts.push('symbols');
    if (!parts.length) return 'empty input';
    if (parts.length === 1) return `${parts[0]} only`;
    return parts.slice(0, -1).join(', ') + ` and ${parts.at(-1)}`;
}

function loginHint(failureCount) {
    const password = String(CHALLENGE.account.password);
    if (failureCount <= 1)
        return `hint: password length is ${password.length} characters.`;
    if (failureCount === 2)
        return `hint: password is composed of ${passwordCharset(password)}.`;
    return 'hint: the correct password is the same as the username.';
}

function loginShapeHint() {
    return 'hint: password length and composition are correct, but the password is wrong.';
}

function passwordClassMask(value) {
    let mask = 0;
    if (/[A-Za-z]/.test(value)) mask |= 1;
    if (/\d/.test(value)) mask |= 2;
    if (/[^A-Za-z0-9]/.test(value)) mask |= 4;
    return mask;
}

function passwordCompositionMatches(candidate, password) {
    return passwordClassMask(candidate) === passwordClassMask(password);
}

function selectLoginHint(candidate) {
    const password = String(CHALLENGE.account.password);
    const attempt = String(candidate ?? '');

    if (attempt.length !== password.length) return 1;
    if (!passwordCompositionMatches(attempt, password)) return 2;
    return 'shape';
}

function toneColor(tone) {
    return {
        error: STYLE.error,
        warning: STYLE.warn,
        success: STYLE.input,
        info: STYLE.output,
        muted: STYLE.muted,
        banner: STYLE.output,
        normal: STYLE.print,
        system: STYLE.output,
        kernel: STYLE.output,
    }[tone] ?? STYLE.print;
}

function roleStyle(role, fallbackTone) {
    return {
        normal: {color: toneColor(fallbackTone)},
        file: {color: toneColor(fallbackTone)},
        directory: {color: STYLE.blue, fontWeight: '700'},
        symlink: {color: STYLE.cyan},
        executable: {color: STYLE.input, fontWeight: '700'},
        device: {color: STYLE.warn, fontWeight: '700'},
        socket: {color: STYLE.magenta, fontWeight: '700'},
        fifo: {color: STYLE.warn, fontWeight: '700'},
    }[role] ?? {color: toneColor(fallbackTone)};
}

function applyStyle(element, style) {
    if (style.color) element.style.color = style.color;
    if (style.fontWeight) element.style.fontWeight = style.fontWeight;
    if (style.fontStyle) element.style.fontStyle = style.fontStyle;
}

function classToken(value, fallback = 'normal') {
    const token = String(value ?? fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return token || fallback;
}

function statusColor(line) {
    const text = String(line);
    if (/PERMISSION DENIED|failed|denied/i.test(text))
        return STYLE.error;
    if (/critical/i.test(text) && !/no\s+critical\s+issues/i.test(text))
        return STYLE.error;
    if (/SUCCESS|completed|activated|no\s+critical\s+issues|^\[\+\]/i.test(text))
        return STYLE.input;
    if (/Verifying|OS|Integrity|Kernel|Access|IDS\/IPS|Encryption|Auditing|Policy/i.test(text))
        return STYLE.output;
    return STYLE.print;
}

function createAppDOM() {
    const host = document.getElementById(BASE.hook);
    if (!host) throw new Error(`missing mount element: #${BASE.hook}`);
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = `
        <style>
            :host {
                color: inherit;
                font: inherit;
            }

            .terminal-container {
                color: inherit;
                overflow: hidden;
                font: inherit;
            }

            .terminal-title {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 15px;
                font-weight: bold;
                text-align: left;
            }

            .terminal-subtitle {
                text-align: center;
                font-weight: bold;
                padding: 5px 0;
            }

            .terminal-body {
                position: relative;
                padding: 20px 15px;
            }

            .input-group {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 15px;
            }

            .input-label {
                width: 100px;
                margin-right: 10px;
                text-align: right;
            }

            .input-field {
                width: 16ch;
                padding: 5px;
                color: inherit;
                background: transparent;
                border: none;
                outline: none;
                font: inherit;
                -webkit-tap-highlight-color: transparent;
            }

            .input-field:focus,
            .command-input:focus {
                outline: none;
                box-shadow: none;
            }

            .action-btn:focus-visible {
                color: ${STYLE.output};
            }

            .button-container {
                display: flex;
                justify-content: center;
                margin: 20px 0;
            }

            .action-btn {
                padding: 5px 15px;
                color: inherit;
                background: transparent;
                border: none;
                cursor: pointer;
                font: inherit;
            }

            .action-btn:disabled,
            .input-field:disabled {
                cursor: default;
                opacity: 0.55;
            }

            .input-field::-webkit-credentials-auto-fill-button,
            .command-input::-webkit-credentials-auto-fill-button {
                visibility: hidden;
                pointer-events: none;
            }

            .terminal-footer {
                display: flex;
                justify-content: space-between;
                padding: 8px 15px;
            }

            .output-content {
                display: none;
                color: ${STYLE.print};
                white-space: pre-wrap;
                line-height: 1.5;
                max-height: min(68vh, 680px);
                overflow-y: auto;
                scrollbar-width: thin;
            }

            .output-line {
                word-break: break-all;
            }

            .output-content.editor-active {
                max-height: none;
                overflow: hidden;
                white-space: pre;
            }

            .editor-screen {
                box-sizing: border-box;
                display: grid;
                grid-template-rows: 1fr auto;
                height: min(68vh, 680px);
                min-height: 18em;
                color: ${STYLE.print};
                cursor: text;
                font-variant-ligatures: none;
                tab-size: 4;
            }

            .editor-body {
                overflow: hidden;
            }

            .editor-row {
                display: flex;
                min-height: 1.5em;
                line-height: 1.5;
            }

            .editor-line-no {
                flex: 0 0 4ch;
                margin-right: 1ch;
                color: ${STYLE.muted};
                text-align: right;
                user-select: none;
            }

            .editor-text {
                white-space: pre;
            }

            .editor-cursor {
                display: inline-block;
                min-width: 1ch;
                color: #050807;
                background: ${STYLE.input};
            }

            .editor-mode-insert .editor-cursor {
                color: ${STYLE.input};
                background: transparent;
                box-shadow: inset 2px 0 0 ${STYLE.input};
            }

            .editor-mode-command .editor-cursor {
                background: ${STYLE.output};
            }

            .editor-status {
                display: flex;
                gap: 2ch;
                justify-content: space-between;
                min-height: 1.5em;
                margin-top: 6px;
                padding: 0 1ch;
                color: #050807;
                background: ${STYLE.input};
                line-height: 1.5;
                white-space: pre;
            }

            .editor-mode-insert .editor-status {
                background: ${STYLE.warn};
            }

            .editor-mode-command .editor-status {
                background: ${STYLE.output};
            }

            .editor-status-main,
            .editor-status-help {
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .editor-status-main {
                min-width: 0;
            }

            .editor-status-help {
                flex-shrink: 0;
                opacity: 0.7;
            }

            .command-container {
                position: relative;
                display: none;
                align-items: center;
                margin-top: 10px;
            }

            .command-container.editor-active {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 1px;
                height: 1px;
                overflow: hidden;
                margin: 0;
                opacity: 0;
            }

            .command-prompt {
                margin-right: 5px;
                color: ${STYLE.prompt};
                user-select: none;
                white-space: nowrap;
            }

            .command-input {
                flex: 1;
                min-width: 0;
                color: ${STYLE.input};
                background: transparent;
                border: none;
                outline: none;
                font: inherit;
            }
        </style>
        <div class="terminal-container">
            <div class="terminal-header">
                <div class="terminal-title">${BASE.title}</div>
                <div class="terminal-subtitle">${BASE.subtitle}</div>
            </div>
            <div class="terminal-body" role="application"
                aria-label="Blog Security terminal">
                <div class="terminal-logon">
                    <div class="input-group">
                        <label class="input-label" for="blog-user">username:</label>
                        <input id="blog-user" class="input-field username"
                            type="text" value="admin" autocomplete="off"
                            autocapitalize="off" autocorrect="off"
                            spellcheck="false" data-1p-ignore="true"
                            data-lpignore="true" data-form-type="other">
                    </div>
                    <div class="input-group">
                        <label class="input-label" for="blog-pass">password:</label>
                        <input id="blog-pass" class="input-field password"
                            type="password" autocomplete="off"
                            data-1p-ignore="true" data-lpignore="true"
                            data-form-type="other">
                    </div>
                    <div class="button-container">
                        <button class="action-btn ok-btn" type="button">OK</button>
                    </div>
                </div>
                <div class="output-content" role="log" aria-live="polite"></div>
                <div class="command-container">
                    <span class="command-prompt"></span>
                    <input class="command-input" type="text"
                        name="blog-security-terminal-command"
                        autocomplete="off" autocapitalize="off"
                        autocorrect="off" spellcheck="false" inputmode="text"
                        aria-autocomplete="none" aria-label="terminal command"
                        data-1p-ignore="true" data-lpignore="true"
                        data-form-type="other" readonly>
                </div>
            </div>
            <div class="terminal-footer"></div>
        </div>
    `;
    return shadow;
}

function appendLine(root, content = '', color = STYLE.print) {
    const output = $(root, SELECTORS.output);
    output.style.display = 'block';
    const line = document.createElement('div');
    line.className = 'output-line';
    line.style.color = color;
    if (content instanceof Node) line.appendChild(content);
    else line.textContent = String(content);
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
    return line;
}

function clearOutput(root) {
    $(root, SELECTORS.output).replaceChildren();
}

function setCommandInput(root, inputState) {
    const input = $(root, SELECTORS.commandInput);
    if (input.disabled) return;
    if (inputState.raw) {
        input.value = '';
        input.readOnly = true;
        input.focus();
        return;
    }
    input.readOnly = false;
    input.value = inputState.value ?? '';
    requestAnimationFrame(() => {
        const cursor = inputState.cursor ?? input.value.length;
        input.setSelectionRange(cursor, cursor);
        input.focus();
    });
}

function resetLoginView(root) {
    state.prompt = 'login: ';
    state.loginPending = false;
    state.loginFailures = 0;
    state.loginAttemptPassword = '';
    state.locked = false;
    state.sessionReady = false;

    const input = $(root, SELECTORS.commandInput);
    input.value = '';
    input.disabled = false;
    input.readOnly = true;

    $(root, SELECTORS.commandRow).style.display = 'none';
    $(root, SELECTORS.commandPrompt).textContent = state.prompt;
    $(root, SELECTORS.subtitle).style.display = '';
    $(root, SELECTORS.loginForm).style.display = '';
    $(root, SELECTORS.password).value = '';
    setLoginControls(root, false);
    requestAnimationFrame(() => $(root, SELECTORS.password).focus());
}

async function typeLine(root, line) {
    if (!line.includes('{{LOADING}}')) {
        appendLine(root, line, statusColor(line));
        return;
    }

    const span = document.createElement('span');
    span.textContent = line.replace('{{LOADING}}', STYLE.spinner[0]);
    appendLine(root, span, statusColor(line));

    const reducedMotion = prefersReducedMotion();
    const ticks = reducedMotion
        ? LOGIN_CHECK_CONFIG.reduced_motion_spinner_ticks
        : LOGIN_CHECK_CONFIG.spinner_ticks;
    const delay = reducedMotion
        ? LOGIN_CHECK_CONFIG.reduced_motion_spinner_delay_ms
        : LOGIN_CHECK_CONFIG.spinner_delay_ms;
    for (let index = 0; index < ticks; index++) {
        span.textContent = line.replace(
            '{{LOADING}}',
            STYLE.spinner[index % STYLE.spinner.length],
        );
        if (delay) await wait(delay);
    }
    span.textContent = line.replace('{{LOADING}}', '*');
}

async function typeBlock(root, text) {
    for (const line of String(text).split('\n')) await typeLine(root, line);
}

function createPromptFragment(prompt) {
    const fragment = document.createDocumentFragment();
    if (!prompt || prompt.kind !== 'shell') {
        const span = document.createElement('span');
        span.textContent = state.prompt;
        span.style.color = STYLE.prompt;
        fragment.appendChild(span);
        return fragment;
    }

    const promptColor = prompt.root ? STYLE.root : STYLE.prompt;
    const pieces = [
        [prompt.user, promptColor, '700'],
        [':', STYLE.muted],
        [prompt.displayCwd || prompt.cwd || '/', STYLE.blue],
        [
            `${prompt.root ? '#' : '$'} `,
            promptColor,
            '700',
        ],
    ];
    for (const [text, color, fontWeight] of pieces) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.color = color;
        if (fontWeight) span.style.fontWeight = fontWeight;
        fragment.appendChild(span);
    }
    return fragment;
}

function updatePrompt(root, prompt) {
    if (prompt?.kind !== 'shell') return;
    const symbol = prompt.root ? '#' : '$';
    const cwd = prompt.displayCwd || prompt.cwd || '/';
    state.prompt = `${prompt.user}:${cwd}${symbol} `;
    $(root, SELECTORS.commandPrompt).replaceChildren(
        createPromptFragment(prompt),
    );
}

function appendSegments(root, item) {
    if (!Array.isArray(item.segments)) {
        appendLine(root, item.text ?? '', toneColor(item.tone));
        return;
    }
    const span = document.createElement('span');
    for (const segment of item.segments) {
        const piece = document.createElement('span');
        piece.textContent = segment.text ?? '';
        applyStyle(piece, roleStyle(segment.role, item.tone));
        span.appendChild(piece);
    }
    appendLine(root, span, toneColor(item.tone));
}

function renderAppScreen(root, screen) {
    const entering = !state.appRaw;
    state.appRaw = true;
    const output = $(root, SELECTORS.output);
    const commandRow = $(root, SELECTORS.commandRow);
    output.classList.add('editor-active');
    commandRow.classList.add('editor-active');
    if (entering) {
        state.appOutputSnapshot = document.createDocumentFragment();
        state.appOutputSnapshot.append(...output.childNodes);
    }
    clearOutput(root);

    const mode = classToken(screen.mode);
    const wrap = document.createElement('div');
    wrap.className = `editor-screen editor-mode-${mode}`;
    wrap.dataset.editor = screen.editor ?? 'editor';
    wrap.dataset.mode = screen.mode ?? 'normal';

    const body = document.createElement('div');
    body.className = 'editor-body';

    for (const row of screen.rows ?? []) {
        const line = document.createElement('div');
        line.className = 'editor-row';

        const number = row.number === null
            ? '    '
            : String(row.number).padStart(4);
        const gutter = document.createElement('span');
        gutter.className = 'editor-line-no';
        gutter.textContent = number;
        line.appendChild(gutter);

        const text = row.text ?? '';
        const cursor = row.cursor;
        if (cursor === null) {
            const content = document.createElement('span');
            content.className = 'editor-text';
            content.textContent = text;
            line.appendChild(content);
            body.appendChild(line);
            continue;
        }

        const before = document.createElement('span');
        before.className = 'editor-text';
        before.textContent = text.slice(0, cursor);
        line.appendChild(before);

        const caret = document.createElement('span');
        caret.className = 'editor-cursor';
        caret.textContent = text[cursor] ?? ' ';
        line.appendChild(caret);

        const after = document.createElement('span');
        after.className = 'editor-text';
        after.textContent = text.slice(cursor + 1);
        line.appendChild(after);

        body.appendChild(line);
    }

    const status = document.createElement('div');
    status.className = 'editor-status';
    const statusMain = document.createElement('span');
    statusMain.className = 'editor-status-main';
    statusMain.textContent = screen.status ?? '';
    const statusHelp = document.createElement('span');
    statusHelp.className = 'editor-status-help';
    statusHelp.textContent = 'Esc normal | i insert | :wq save and quit';
    status.append(statusMain, statusHelp);

    wrap.append(body, status);
    output.appendChild(wrap);
    output.style.display = 'block';
    const input = $(root, SELECTORS.commandInput);
    input.value = '';
    input.readOnly = true;
    input.focus();
}

function exitAppScreen(root) {
    if (!state.appRaw && !state.appOutputSnapshot) return;
    state.appRaw = false;
    const output = $(root, SELECTORS.output);
    output.classList.remove('editor-active');
    $(root, SELECTORS.commandRow).classList.remove('editor-active');
    $(root, SELECTORS.commandPrompt).textContent = state.prompt;
    output.replaceChildren();
    if (state.appOutputSnapshot) output.appendChild(state.appOutputSnapshot);
    state.appOutputSnapshot = null;
    output.scrollTop = output.scrollHeight;
}

async function completeLogin(root, user) {
    state.sessionReady = true;
    state.loginPending = false;
    state.loginFailures = 0;
    state.loginAttemptPassword = '';
    state.locked = false;

    $(root, SELECTORS.subtitle).style.display = 'none';
    $(root, SELECTORS.loginForm).style.display = 'none';

    await typeBlock(root, renderTemplate(TEMPLATES.accessSuccess, {
        USER: user,
        TIME: new Date().toString(),
        IP: randomIp(),
    }));

    $(root, SELECTORS.commandRow).style.display = 'flex';
    const input = $(root, SELECTORS.commandInput);
    input.disabled = false;
    input.readOnly = false;
    input.focus();
}

function setLoginControls(root, disabled) {
    $(root, SELECTORS.username).disabled = disabled;
    $(root, SELECTORS.password).disabled = disabled;
    $(root, SELECTORS.ok).disabled = disabled;
}

async function failLogin(root, user) {
    state.loginPending = false;
    state.loginFailures++;
    const hint = selectLoginHint(state.loginAttemptPassword);
    await typeBlock(root, renderTemplate(TEMPLATES.accessDenied, {
        USER: user,
        HINT: hint === 'shape' ? loginShapeHint() : loginHint(hint),
    }));
    if (!state.locked) {
        setLoginControls(root, false);
        $(root, SELECTORS.password).select();
    }
}

function wireTTY(root) {
    state.tty.on('output', item => {
        if (!state.sessionReady) {
            if (state.loginPending && item.text === 'Login incorrect') {
                void failLogin(root, $(root, SELECTORS.username).value || 'unknown');
            }
            return;
        }
        if (state.appRaw) exitAppScreen(root);
        if (item?.type === 'control' && item.action === 'clear') {
            clearOutput(root);
            return;
        }
        appendSegments(root, item);
    });

    state.tty.on('echo', event => {
        if (!state.sessionReady) return;
        const line = document.createElement('span');
        line.appendChild(createPromptFragment(event.prompt));
        const command = document.createElement('span');
        command.textContent = event.text;
        command.style.color = STYLE.print;
        line.appendChild(command);
        appendLine(root, line);
    });

    state.tty.on('prompt', prompt => {
        if (prompt?.kind === 'login' && state.sessionReady) {
            resetLoginView(root);
            return;
        }
        if (prompt?.kind === 'dead' && state.sessionReady) {
            $(root, SELECTORS.commandPrompt).textContent =
                prompt.label ? `${prompt.label} ` : '[dead] ';
            $(root, SELECTORS.commandInput).disabled = true;
            return;
        }
        updatePrompt(root, prompt);
    });
    state.tty.on('clear', () => clearOutput(root));
    state.tty.on('input', input => {
        if (state.sessionReady) setCommandInput(root, input);
    });
    state.tty.on('app-screen', screen => {
        if (state.sessionReady) renderAppScreen(root, screen);
    });
    state.tty.on('app-exit', () => {
        exitAppScreen(root);
    });
    state.tty.on('lockout', () => {
        state.loginPending = false;
        state.locked = true;
        appendLine(root, 'Maximum authentication failures. Reload to try again.', STYLE.error);
        setLoginControls(root, true);
    });
    state.tty.on('power', power => {
        state.loginPending = false;
        state.locked = false;
        state.sessionReady = false;
        const input = $(root, SELECTORS.commandInput);
        input.value = '';
        input.disabled = true;
        input.readOnly = true;
        appendLine(
            root,
            power.action === 'restart'
                ? 'Connection closed. Rebooting...'
                : 'Connection closed. System halted.',
            STYLE.warn,
        );
        if (power.action === 'restart') rebootApp(root);
    });

    state.tty.on('state', ttyState => {
        if (ttyState.prompt?.kind === 'shell')
            updatePrompt(root, ttyState.prompt);
        if (state.loginPending && ttyState.user) {
            void completeLogin(root, ttyState.user);
        }
    });
}

function startTTY(root) {
    state.tty = default_kernel.create_tty({
        login: true,
        banner: false,
        max_login_failures: 5,
    });
    wireTTY(root);
    state.tty.start();
}

function rebootApp(root) {
    const oldTTY = state.tty;
    setTimeout(() => {
        oldTTY?.destroy();
        if (state.tty !== oldTTY) return;

        default_kernel.reset();
        default_kernel.boot(APP_BOOT_OPTIONS);
        default_kernel.apply_profile(initChallenge);
        clearOutput(root);
        resetLoginView(root);
        startTTY(root);
    }, REBOOT_DELAY_MS);
}

async function login(root) {
    if (state.loginPending || state.sessionReady || state.locked) return;

    const username = $(root, SELECTORS.username).value.trim();
    const password = $(root, SELECTORS.password).value;

    setLoginControls(root, true);

    clearOutput(root);
    state.loginPending = true;
    state.loginAttemptPassword = password;

    await typeBlock(root, TEMPLATES.sysInfo);
    await typeBlock(root, TEMPLATES.envCheck);

    state.tty.submit(username);
    state.tty.submit(password);
}

function wireInputs(root) {
    $(root, SELECTORS.ok).addEventListener('click', () => login(root));
    $(root, SELECTORS.username).addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        $(root, SELECTORS.password).focus();
    });
    $(root, SELECTORS.password).addEventListener('keydown', event => {
        if (event.key === 'Enter') login(root);
    });
    $(root, '.terminal-container').addEventListener('click', event => {
        if (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLButtonElement) return;
        const target = state.sessionReady
            ? $(root, SELECTORS.commandInput)
            : $(root, SELECTORS.password);
        if (target === $(root, SELECTORS.commandInput))
            target.readOnly = state.appRaw;
        target.focus();
    });
    $(root, SELECTORS.commandInput).addEventListener('keydown', event => {
        const input = event.currentTarget;
        if (state.appRaw) {
            event.preventDefault();
            input.readOnly = true;
            state.tty.handleKey(event.key, {
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            });
            input.value = '';
            return;
        }
        input.readOnly = false;
        if (event.key === 'Enter') {
            event.preventDefault();
            state.tty.submit(input.value);
            return;
        }
        if (NAVIGATION_KEYS.has(event.key)) {
            event.preventDefault();
            state.tty.handleKey(event.key, {
                value: input.value,
                cursor: input.selectionStart ?? input.value.length,
            });
            return;
        }
        if (event.ctrlKey && CONTROL_KEYS.has(event.key.toLowerCase())) {
            event.preventDefault();
            state.tty.handleKey(event.key, {
                value: input.value,
                cursor: input.selectionStart ?? input.value.length,
                ctrlKey: true,
            });
            return;
        }
    });
}

function main() {
    const root = createAppDOM();
    default_kernel.boot(APP_BOOT_OPTIONS);
    default_kernel.apply_profile(initChallenge);
    wireInputs(root);
    startTTY(root);
    $(root, SELECTORS.password).focus();
}

main();
