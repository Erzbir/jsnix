/**
 * usr/programs/security/su.js - su user-space program
 */

'use strict';

import {register_binary} from '../../../kernel/exec/program_registry.js';

function parse_args(args) {
    const parsed = {
        login: false,
        command: null,
        user: 'root',
        password: undefined,
        error: null,
    };
    const positional = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-') {
            parsed.login = true;
            continue;
        }
        if (arg === '-l' || arg === '--login') {
            parsed.login = true;
            continue;
        }
        if (arg === '-c' || arg === '--command') {
            if (index + 1 >= args.length) {
                parsed.error = `${arg}: option requires an argument`;
                return parsed;
            }
            parsed.command = args[++index];
            continue;
        }
        if (arg === '--') {
            positional.push(...args.slice(index + 1));
            break;
        }
        if (arg.startsWith('-') && arg !== '-') {
            parsed.error = `${arg}: invalid option`;
            return parsed;
        }
        positional.push(arg);
    }

    parsed.user = positional[0] ?? 'root';
    parsed.password = positional[1];
    return parsed;
}

function split_command(command) {
    return String(command)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function forward_result(ctx, result, command) {
    if (!result) {
        ctx.perror(`su: ${command}: command not found`);
        return 127;
    }
    ctx.stdout_buf.push(...result.stdout_buf);
    ctx.stderr_buf.push(...result.stderr_buf);
    return result.exit_code;
}

function su(ctx) {
    const parsed = parse_args(ctx.args);
    if (parsed.error) {
        ctx.perror(`su: ${parsed.error}`);
        return 1;
    }

    let account;
    try {
        account = ctx.su(parsed.user, parsed.password);
    } catch {
        ctx.perror('su: Authentication failure');
        return 1;
    }

    const home = account.home ?? account.pw_dir ?? '/';
    const shell = account.shell ?? account.pw_shell ?? '/bin/sh';
    try {
        ctx.setenv('LOGNAME', account.username ?? account.pw_name);
        ctx.setenv('USER', account.username ?? account.pw_name);
        ctx.setenv('HOME', home);
        ctx.setenv('SHELL', shell);
        if (parsed.login) ctx.chdir(home);
    } catch {
        // Keep the credential switch authoritative even if optional
        // environment setup fails in the simulated runtime.
    }

    if (parsed.command) {
        const argv = split_command(parsed.command);
        if (!argv.length) return 0;
        return forward_result(ctx, ctx.run(argv), argv[0]);
    }

    return forward_result(ctx, ctx.run([shell]), shell);
}

register_binary('su', su, '/usr/bin/su', {
    mode: 0o4755,
    uid: 0,
    gid: 0,
});
