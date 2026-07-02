/**
 * usr/programs/shells.js - Shell executable programs
 */

'use strict';

import {ksyms} from '../../kernel/ksyms.js';
import {register_binary} from '../../kernel/exec/program_registry.js';
import {Bash} from '../shell/bash.js';

function copy_script_result(ctx, result) {
    ctx.stdout_buf.push(...result.stdout_buf);
    ctx.stderr_buf.push(...result.stderr_buf);
    return result.exit_code;
}

function script_body(content) {
    const text = String(content ?? '');
    if (!text.startsWith('#!')) return text;
    const first_newline = text.indexOf('\n');
    return first_newline < 0 ? '' : text.slice(first_newline + 1);
}

function exit_shell(shell, status) {
    if (!shell?.is_alive) return;
    ksyms.syscall(
        shell.pid,
        ksyms.nr.__NR_exit,
        Number.isInteger(status) ? status & 0xff : 0,
    );
}

function run_with_shell(ctx, shell_name, fn) {
    const shell = new Bash(ctx.getuid(), ctx.getgid(), {
        cwd: ctx.getcwd(),
        ppid: ctx.getpid(),
        argv0: shell_name,
        history_enabled: false,
    });
    let status = 0;
    const finish = value => {
        status = value;
        exit_shell(shell, status);
        return status;
    };
    try {
        const result = fn(shell);
        if (result && typeof result.then === 'function')
            return result.then(finish, error => {
                status = 1;
                exit_shell(shell, status);
                throw error;
            });
        return finish(result);
    } catch (error) {
        exit_shell(shell, status);
        throw error;
    }
}

function run_script(ctx, shell, body, options) {
    if (!shell.script_text_needs_async(body))
        return copy_script_result(ctx, shell.run_script_text(body, options));
    return shell.run_script_text_async(body, options).then(result =>
        copy_script_result(ctx, result));
}

function run_shell_program(ctx) {
    if (!ctx.args.length) {
        ctx.special('shell-session');
        return 0;
    }

    const shell_name = ctx.argv[0].split('/').pop() || 'sh';

    if (ctx.args[0] === '-c') {
        const command = ctx.args[1];
        if (command === undefined) {
            ctx.perror(`${shell_name}: -c: option requires an argument`);
            return 2;
        }
        return run_with_shell(ctx, shell_name, shell =>
            run_script(ctx, shell, command, {
                argv0: ctx.args[2] ?? shell_name,
                args: ctx.args.slice(3),
                mode: 'shell',
            }));
    }

    if (ctx.args[0].startsWith('-')) {
        ctx.perror(`${shell_name}: ${ctx.args[0]}: unsupported option`);
        return 2;
    }

    const script = ctx.realpath(ctx.args[0]);
    let content;
    try {
        content = ctx.read(script);
    } catch (error) {
        ctx.perror(`${shell_name}: ${ctx.args[0]}: ${error.message}`);
        return 1;
    }
    return run_with_shell(ctx, shell_name, shell =>
        run_script(ctx, shell, script_body(content), {
            argv0: script,
            args: ctx.args.slice(1),
            mode: 'shell',
        }));
}

register_binary('bash', run_shell_program, '/usr/bin/bash');
register_binary('dash', run_shell_program, '/usr/bin/dash');
