'use strict';

import {
    get_boot_state,
    is_kernel_started,
    reset_kernel,
    start_kernel,
} from '../init/boot.js';
import {
    ROOT_GID,
    ROOT_UID,
} from '../kernel/include/types.js';
import {create_kernel_view} from '../kernel/public.js';
import {create_tty as create_tty_core} from '../drivers/tty/index.js';
import {Bash} from '../usr/shell/bash.js';
import {reset_bash_history} from '../usr/shell/history.js';

import {reset_program_state} from '../usr/programs/index.js';

const BOOT_OPTION_KEYS = [
    'include_guest',
    'hostname',
    'issue',
    'root_password',
    'users',
    'accounts',
    'default_users',
    'default_accounts',
];

function has_own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function boot_options_from(options = {}, defaults = {}) {
    const result = {};
    for (const key of BOOT_OPTION_KEYS) {
        if (has_own(options, key)) result[key] = options[key];
        else if (has_own(defaults, key)) result[key] = defaults[key];
    }
    if (!has_own(result, 'include_guest'))
        result.include_guest = true;
    return result;
}

function split_tty_options(options = {}) {
    const boot = {};
    const tty = {};
    for (const [key, value] of Object.entries(options)) {
        if (BOOT_OPTION_KEYS.includes(key)) boot[key] = value;
        else tty[key] = value;
    }
    return {boot, tty};
}

function reset_runtime_state() {
    reset_kernel();
    reset_program_state();
    reset_bash_history();
}

class kernel_profile_context {
    constructor() {
        this.root_shell = new Bash(ROOT_UID, ROOT_GID);
    }

    run_as_root(command) {
        const output = this.root_shell.execute(command);
        return {
            command,
            output,
            status: this.root_shell.last_exit_status,
            text: output.map(line => line.text ?? '').join('\n'),
        };
    }
}

export class kernel_facade {
    constructor(options = {}) {
        this.name = options.name ?? 'jsnix';
        this.boot_options = boot_options_from(options);
        this.isolated = false;
        this.inspect = create_kernel_view();
        if (options.auto_boot) this.boot();
    }

    get booted() {
        return is_kernel_started();
    }

    get boot_state() {
        return get_boot_state();
    }

    boot(options = {}) {
        start_kernel(boot_options_from(options, this.boot_options));
        return this;
    }

    reset() {
        reset_runtime_state();
        return this;
    }

    create_tty(options = {}) {
        const {boot, tty} = split_tty_options(options);
        this.boot(boot_options_from(boot, this.boot_options));
        return create_tty_core(tty);
    }

    apply_profile(initializer, ...args) {
        if (typeof initializer !== 'function')
            throw new TypeError('kernel.apply_profile: initializer must be function');
        this.boot();
        return initializer(new kernel_profile_context(), ...args);
    }
}

export function create_kernel(options = {}) {
    return new kernel_facade(options);
}

export function create_test_kernel(options = {}) {
    reset_runtime_state();
    return new kernel_facade(options);
}

export const default_kernel = create_kernel();
