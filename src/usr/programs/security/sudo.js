/**
 * usr/programs/security/sudo.js - sudo user-space program
 */

'use strict';

import {register_binary} from '../../../kernel/exec/program_registry.js';

function canonical_command(ctx, command) {
    const path = ctx.get_binary_path(command);
    if (!path) return null;
    try {
        return ctx.canonicalize(path);
    } catch {
        return path;
    }
}

function policy_allows(ctx, username, command) {
    let sudoers;
    try {
        const stat = ctx.stat('/etc/sudoers');
        if (stat.st_uid !== 0 || (stat.st_mode & 0o022) !== 0)
            return false;
        sudoers = ctx.read('/etc/sudoers');
    } catch {
        return false;
    }

    for (const raw_line of String(sudoers).split('\n')) {
        const line = raw_line.replace(/#.*$/, '').trim();
        if (!line || line.startsWith('Defaults')) continue;
        const match = line.match(
            /^(\S+)\s+ALL=\(ALL(?::ALL)?\)\s+(?:(NOPASSWD):\s*)?(.+)$/
        );
        if (!match || match[1] !== username) continue;
        if (!match[2] && username !== 'root') continue;

        const allowed = match[3].split(',').map(value => value.trim());
        for (const candidate of allowed) {
            if (candidate === 'ALL') return true;
            try {
                if (ctx.canonicalize(candidate) === command) return true;
            } catch {
                if (candidate === command) return true;
            }
        }
    }
    return false;
}

function sudo(ctx) {
    if (!ctx.args.length) {
        ctx.perror('sudo: a command is required');
        return 1;
    }

    if (ctx.geteuid() !== 0) {
        ctx.perror(
            'sudo: effective uid is not 0; ' +
            'is /usr/bin/sudo owned by root and setuid?'
        );
        return 1;
    }

    const invoking_uid = ctx.getuid();
    const invoking_gid = ctx.getgid();
    const invoking_user =
        ctx.getpwuid(invoking_uid)?.pw_name ?? String(invoking_uid);
    const command = canonical_command(ctx, ctx.args[0]);
    if (!command) {
        ctx.perror(`sudo: ${ctx.args[0]}: command not found`);
        return 127;
    }
    if (!policy_allows(ctx, invoking_user, command)) {
        ctx.perror(
            `sudo: ${invoking_user} is not allowed to execute ` +
            `${command} as root on jsnix`
        );
        return 1;
    }

    const root = ctx.getpwuid(0);
    if (!root) {
        ctx.perror('sudo: unknown user root');
        return 1;
    }

    try {
        ctx.setenv('SUDO_USER', invoking_user);
        ctx.setenv('SUDO_UID', String(invoking_uid));
        ctx.setenv('SUDO_GID', String(invoking_gid));
        ctx.setenv('USER', root.pw_name);
        ctx.setenv('HOME', root.pw_dir);
        ctx.setgroups([root.pw_gid]);
        ctx.setgid(root.pw_gid);
        ctx.setuid(root.pw_uid);
    } catch (error) {
        ctx.perror(`sudo: unable to set target credentials: ${error.message}`);
        return 1;
    }

    const result = ctx.run([command, ...ctx.args.slice(1)]);
    if (!result) {
        ctx.perror(`sudo: ${ctx.args[0]}: command not found`);
        return 127;
    }
    ctx.stdout_buf.push(...result.stdout_buf);
    ctx.stderr_buf.push(...result.stderr_buf);
    return result.exit_code;
}

register_binary('sudo', sudo, '/usr/bin/sudo', {
    mode: 0o4755,
    uid: 0,
    gid: 0,
});
