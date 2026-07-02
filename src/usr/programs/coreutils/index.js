/**
 * usr/programs/coreutils/index.js - Core userland utilities
 *
 * Analogous to:
 *   GNU coreutils  (ls, cat, cp, mv, rm, mkdir, stat, and chmod)
 *   util-linux     (kill and su)
 *   shadow-utils   (useradd, userdel, and passwd)
 *   procps         (ps, top, and free)
 *   bash built-ins exposed as standalone commands
 *
 * Each utility: (ctx: proc_ctx) -> exit_code: number
 */

'use strict';

import {
    EISDIR,
    EPERM,
    SIGTERM,
} from '../../../kernel/include/types.js';
import {ksyms} from '../../../kernel/ksyms.js';
import {
    compile_program_image,
    parse_js_script_image,
} from '../../../kernel/exec/binfmt_js.js';
import {register_binary} from '../../../kernel/exec/program_registry.js';
import {
    is_shell_builtin,
    is_shell_reserved_word,
} from '../../shell/builtins.js';
import {
    copy_tree,
    emit_text,
    file_role,
    fmt_uptime,
    groups_for_user,
    parse_flags,
    parse_symbolic_mode,
    remove_tree,
    resolve_group,
    resolve_user,
    strmode,
    walk_tree,
} from './helpers.js';

// List directory contents.
function ls(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    const long_fmt = flags.has('l');
    const show_all = flags.has('a') || flags.has('A');
    const implicit_path = positional.length === 0;
    const paths = implicit_path ? ['.'] : positional;
    let status = 0;

    const display = entries => {
        if (!long_fmt) {
            const width = 20;
            let segments = [];
            entries.forEach((entry, index) => {
                let stat;
                try {
                    stat = entry.stat ?? ctx.lstat(entry.abs);
                } catch {
                    return;
                }
                segments.push({
                    text: entry.name,
                    role: file_role(stat),
                });
                if ((index + 1) % 4 === 0) {
                    ctx.printSegments(segments);
                    segments = [];
                } else {
                    segments.push({
                        text: ' '.repeat(Math.max(1, width - entry.name.length)),
                        role: 'normal',
                    });
                }
            });
            if (segments.length) {
                if (segments.at(-1)?.role === 'normal') segments.pop();
                ctx.printSegments(segments);
            }
            return;
        }

        for (const entry of entries) {
            let stat;
            try {
                stat = entry.stat ?? ctx.lstat(entry.abs);
            } catch {
                continue;
            }
            const permission = strmode(stat.st_mode);
            const owner = ctx.get_username(stat.st_uid).padEnd(8);
            const group = ctx.get_groupname(stat.st_gid).padEnd(8);
            const size = String(stat.st_size).padStart(6);
            const date = new Date(stat.st_mtime).toLocaleString(
                'en',
                {month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'}
            );
            const name = stat.type === 'link'
                ? `${entry.name} -> ${ctx.readlink(entry.abs)}`
                : entry.name;
            ctx.printSegments([
                {
                    text:
                        `${permission} ${String(stat.st_nlink).padStart(2)} ` +
                        `${owner} ${group} ${size} ${date} `,
                    role: 'normal',
                },
                {
                    text: name,
                    role: file_role(stat),
                },
            ]);
        }
    };

    paths.forEach((path, path_index) => {
        const absolute = ctx.realpath(path);
        try {
            let stat = ctx.lstat(absolute);
            const directory_reference =
                implicit_path ||
                path === '.' ||
                path === '..' ||
                path.endsWith('/') ||
                path.endsWith('/.') ||
                path.endsWith('/..');
            if (stat.type === 'link' &&
                (directory_reference || (!long_fmt && !flags.has('d'))))
                stat = ctx.stat(absolute);
            if (path_index > 0) ctx.printf('');
            if (stat.type !== 'dir' || flags.has('d')) {
                const stripped = path.replace(/\/+$/, '');
                display([{
                    name: implicit_path
                        ? '.'
                        : stripped.split('/').pop() || '/',
                    abs: absolute,
                    stat,
                }]);
                return;
            }
            if (paths.length > 1) ctx.printf(`${path}:`);
            const entries = ctx.readdir(absolute)
                .filter(name => show_all || !name.startsWith('.'))
                .map(name => ({
                    name,
                    abs: absolute === '/' ? `/${name}` : `${absolute}/${name}`,
                }));
            if (show_all)
                entries.unshift(
                    {name: '..', abs: ctx.realpath(`${absolute}/..`)},
                    {name: '.', abs: absolute}
                );
            display(entries);
        } catch (error) {
            ctx.perror(`ls: cannot access '${path}': ${error.message}`);
            status = 1;
        }
    });
    return status;
}

// Print the current working directory.
function pwd(ctx) {
    ctx.printf(ctx.getcwd());
    return 0;
}

// Concatenate files or standard input.
function cat(ctx) {
    const number = ctx.args.includes('-n');
    const files = ctx.args.filter(arg => arg !== '-n');
    if (!files.length) files.push('-');
    let rc = 0;
    let line_number = 1;
    for (const f of files) {
        try {
            const content = f === '-' ? ctx.stdin : ctx.read(ctx.realpath(f));
            const lines = content.split('\n');
            if (lines.at(-1) === '') lines.pop();
            for (const line of lines) {
                ctx.printf(number ?
                    `${String(line_number++).padStart(6)}\t${line}` : line);
            }
        } catch (e) {
            ctx.perror(`cat: ${f}: ${e.message}`);
            rc = 1;
        }
    }
    return rc;
}

// Print command arguments.
function echo(ctx) {
    const no_nl = ctx.args[0] === '-n';
    ctx.printf((no_nl ? ctx.args.slice(1) : ctx.args).join(' '));
    return 0;
}

// Create files or update their timestamps.
function touch(ctx) {
    if (!ctx.args.length) {
        ctx.perror('touch: missing operand');
        return 1;
    }
    for (const f of ctx.args) {
        const abs = ctx.realpath(f);
        try {
            const stat = ctx.stat(abs);
            ctx.write(abs, stat.type === 'file' ? ctx.read(abs) : '');
        } catch (e) {
            if (e.errno !== 2) {
                ctx.perror(`touch: cannot touch '${f}': ${e.message}`);
                return 1;
            }
            ctx.write(abs, '');
        }
    }
    return 0;
}

// Create directories.
function mkdir(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (!positional.length) {
        ctx.perror('mkdir: missing operand');
        return 1;
    }
    for (const d of positional) {
        try {
            const abs = ctx.realpath(d);
            if (!flags.has('p')) {
                ctx.mkdir(abs);
                continue;
            }
            let current = '';
            for (const part of abs.split('/').filter(Boolean)) {
                current += '/' + part;
                try {
                    ctx.mkdir(current);
                } catch (e) {
                    if (e.errno !== 17) throw e;
                }
            }
        } catch (e) {
            ctx.perror(`mkdir: cannot create directory '${d}': ${e.message}`);
            return 1;
        }
    }
    return 0;
}

function rmdir(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (!positional.length) {
        ctx.perror('rmdir: missing operand');
        return 1;
    }
    for (const dir of positional) {
        let abs = ctx.realpath(dir);
        try {
            ctx.rmdir(abs);
            if (flags.has('p')) {
                while (abs !== '/') {
                    abs = abs.slice(0, abs.lastIndexOf('/')) || '/';
                    if (abs !== '/') ctx.rmdir(abs);
                }
            }
        } catch (e) {
            ctx.perror(`rmdir: failed to remove '${dir}': ${e.message}`);
            return 1;
        }
    }
    return 0;
}

// Remove files and directories.
function rm(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    const recursive = flags.has('r') || flags.has('R');

    function rm_r(abs) {
        const st = ctx.lstat(abs);
        if (st.type === 'dir') {
            if (!recursive) throw Object.assign(new Error('Is a directory'), {errno: EISDIR});
            for (const child of ctx.readdir(abs))
                rm_r(abs === '/' ? '/' + child : `${abs}/${child}`);
            ctx.rmdir(abs);
        } else {
            ctx.unlink(abs);
        }
    }

    for (const p of positional) {
        try {
            rm_r(ctx.realpath(p));
        } catch (e) {
            ctx.perror(`rm: cannot remove '${p}': ${e.message}`);
            return 1;
        }
    }
    return 0;
}

// Move and copy files.
function mv(ctx) {
    if (ctx.args.length < 2) {
        ctx.perror('mv: missing operand');
        return 1;
    }
    try {
        const source = ctx.realpath(ctx.args[0]);
        let destination = ctx.realpath(ctx.args[1]);
        try {
            if (ctx.stat(destination).type === 'dir')
                destination += `/${source.split('/').pop()}`;
        } catch { /* The destination does not exist. */ }
        ctx.rename(source, destination);
    } catch (e) {
        ctx.perror(`mv: ${e.message}`);
        return 1;
    }
    return 0;
}

function cp(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (positional.length < 2) {
        ctx.perror('cp: missing operand');
        return 1;
    }
    try {
        const source = ctx.realpath(positional[0]);
        let destination = ctx.realpath(positional[1]);
        const source_stat = ctx.stat(source);
        if (source_stat.type === 'dir' &&
            !flags.has('r') && !flags.has('R') && !flags.has('a')) {
            ctx.perror(`cp: -r not specified; omitting directory '${positional[0]}'`);
            return 1;
        }
        try {
            if (ctx.stat(destination).type === 'dir')
                destination += `/${source.split('/').pop()}`;
        } catch { /* The destination does not exist. */ }
        copy_tree(ctx, source, destination);
    } catch (e) {
        ctx.perror(`cp: ${e.message}`);
        return 1;
    }
    return 0;
}

// Change file permission bits.
function chmod(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (positional.length < 2) {
        ctx.perror('chmod: missing operand');
        return 1;
    }
    const [mstr, ...paths] = positional;
    for (const p of paths) {
        try {
            const abs = ctx.realpath(p);
            const apply = (path, stat) => {
                const mode = /^[0-7]{1,4}$/.test(mstr)
                    ? parseInt(mstr, 8)
                    : parse_symbolic_mode(
                        mstr, stat.st_mode, stat.type === 'dir');
                ctx.chmod(path, mode);
            };
            if (flags.has('R')) walk_tree(ctx, abs, apply);
            else apply(abs, ctx.stat(abs));
        } catch (e) {
            ctx.perror(`chmod: '${p}': ${e.message}`);
            return 1;
        }
    }
    return 0;
}

function chown(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (positional.length < 2) {
        ctx.perror('chown: missing operand');
        return 1;
    }
    const [owner_group, ...paths] = positional;
    try {
        const split = owner_group.includes(':')
            ? owner_group.split(':', 2)
            : [owner_group, undefined];
        const uid = resolve_user(ctx, split[0]);
        const gid = resolve_group(ctx, split[1]);
        for (const path of paths) {
            const abs = ctx.realpath(path);
            const apply = target => ctx.chown(target, uid, gid);
            if (flags.has('R')) walk_tree(ctx, abs, apply);
            else apply(abs);
        }
    } catch (e) {
        ctx.perror(`chown: ${e.message}`);
        return 1;
    }
    return 0;
}

function chgrp(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (positional.length < 2) {
        ctx.perror('chgrp: missing operand');
        return 1;
    }
    try {
        const gid = resolve_group(ctx, positional[0]);
        for (const path of positional.slice(1)) {
            const abs = ctx.realpath(path);
            const apply = target => ctx.chown(target, -1, gid);
            if (flags.has('R')) walk_tree(ctx, abs, apply);
            else apply(abs);
        }
    } catch (e) {
        ctx.perror(`chgrp: ${e.message}`);
        return 1;
    }
    return 0;
}

// Display file metadata.
function stat(ctx) {
    if (!ctx.args.length) {
        ctx.perror('stat: missing operand');
        return 1;
    }
    for (const f of ctx.args) {
        const abs = ctx.realpath(f);
        try {
            const s = ctx.stat(abs);
            ctx.printf(`  File: ${abs}`);
            ctx.printf(`  Size: ${s.st_size}\t\tType: ${s.type}`);
            ctx.printf(`  Mode: ${s.st_mode.toString(8).padStart(4, '0')} (${strmode(s.st_mode)})`);
            ctx.printf(`  Uid: ${s.st_uid}  Gid: ${s.st_gid}`);
            ctx.printf(`Modify: ${new Date(s.st_mtime).toISOString()}`);
        } catch (e) {
            ctx.perror(`stat: '${f}': ${e.message}`);
            return 1;
        }
    }
    return 0;
}

// Search a directory tree.
function find(ctx) {
    const {positional} = parse_flags(ctx.args);
    const root = ctx.realpath(positional[0] ?? '.');
    const name_idx = ctx.args.indexOf('-name');
    const rx = name_idx >= 0
        ? new RegExp('^' + ctx.args[name_idx + 1].replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
        : null;

    function walk(abs) {
        let st;
        try {
            st = ctx.lstat(abs);
        } catch {
            return;
        }
        if (!rx || rx.test(abs.split('/').pop())) ctx.printf(abs);
        if (st.type === 'dir')
            try {
                for (const c of ctx.readdir(abs)) walk(abs === '/' ? '/' + c : `${abs}/${c}`);
            } catch { /* Skip directories that cannot be read. */
            }
    }

    walk(root);
    return 0;
}

// Search text for a pattern.
function grep(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    if (!positional.length) {
        ctx.perror('grep: missing pattern');
        return 1;
    }
    const [pattern, ...files] = positional;
    const ic = flags.has('i'), ln = flags.has('n'), inv = flags.has('v');

    function search(content, fname) {
        let found = false;
        content.split('\n').forEach((line, idx) => {
            const hay = ic ? line.toLowerCase() : line;
            const ndl = ic ? pattern.toLowerCase() : pattern;
            if (hay.includes(ndl) !== inv) {
                found = true;
                const pfx = (files.length > 1 ? fname + ':' : '') +
                    (ln ? (idx + 1) + ':' : '');
                ctx.printf(pfx + line);
            }
        });
        return found;
    }

    let found = false;
    if (!files.length) {
        found = search(ctx.stdin, '(stdin)');
    } else {
        for (const f of files) {
            try {
                if (search(ctx.read(ctx.realpath(f)), f)) found = true;
            } catch (e) {
                ctx.perror(`grep: ${f}: ${e.message}`);
            }
        }
    }
    return found ? 0 : 1;
}

// Count lines, words, and bytes.
function wc(ctx) {
    const files = ctx.args.length ? ctx.args : ['-'];
    for (const f of files) {
        try {
            const d = f === '-' ? ctx.stdin : ctx.read(ctx.realpath(f));
            ctx.printf(`${String(d.split('\n').length - 1).padStart(7)} ` +
                `${String(d.trim().split(/\s+/).filter(Boolean).length).padStart(7)} ` +
                `${String(d.length).padStart(7)}${f === '-' ? '' : ` ${f}`}`);
        } catch (e) {
            ctx.perror(`wc: ${f}: ${e.message}`);
            return 1;
        }
    }
    return 0;
}

// Print the beginning or end of input.
function _headtail(ctx, tail) {
    const ni = ctx.args.indexOf('-n');
    const n = ni >= 0 ? parseInt(ctx.args[ni + 1]) : 10;
    const fs = ctx.args.filter((a, i) =>
        !a.startsWith('-') && !(i > 0 && ctx.args[i - 1] === '-n'));
    if (!fs.length) fs.push('-');
    for (const f of fs) {
        try {
            const all = (f === '-' ? ctx.stdin : ctx.read(ctx.realpath(f)))
                .split('\n');
            if (all.at(-1) === '') all.pop();
            for (const l of (tail ? all.slice(-n) : all.slice(0, n))) ctx.printf(l);
        } catch (e) {
            ctx.perror(`${tail ? 'tail' : 'head'}: ${f}: ${e.message}`);
            return 1;
        }
    }
    return 0;
}

function head(ctx) {
    return _headtail(ctx, false);
}

function tail(ctx) {
    return _headtail(ctx, true);
}

// Display processes.
function ps(ctx) {
    const show_all = ctx.args.some(a => /^-?[aAux]+$/.test(a));
    const procs = ctx.list_procs().filter(p => show_all || p.uid === ctx.getuid());
    ctx.dim('  PID  USER       STATE    COMM');
    for (const p of procs)
        ctx.printf(`${String(p.pid).padStart(5)}  ${ctx.get_username(p.uid).padEnd(10)} ${p.state.padEnd(8)} ${p.comm}`);
    return 0;
}

// Send a signal to a process.
function kill(ctx) {
    let signo = SIGTERM;
    const args = [...ctx.args];
    if (args[0]?.startsWith('-')) signo = parseInt(args.shift().slice(1)) || SIGTERM;
    if (!args.length) {
        ctx.perror('kill: missing pid');
        return 1;
    }
    for (const a of args) {
        const p = parseInt(a);
        if (isNaN(p)) {
            ctx.perror(`kill: invalid pid '${a}'`);
            return 1;
        }
        try {
            ctx.kill(p, signo);
            ctx.printf(`kill: sent signal ${signo} to pid ${p}`);
        } catch (e) {
            ctx.perror(`kill: (${p}): ${e.message}`);
            return 1;
        }
    }
    return 0;
}

// Display a process summary.
function top(ctx) {
    const info = ctx.sysinfo();
    ctx.success(`top - ${new Date().toLocaleTimeString()} up ${fmt_uptime(info.uptime)}, 1 user`);
    ctx.info(`Tasks: ${info.procs} total  Mem: ${info.totalram} kB total, ${info.freeram} kB free`);
    ctx.dim('  PID  USER       STATE    COMM');
    for (const p of ctx.list_procs())
        ctx.printf(`${String(p.pid).padStart(5)}  ${ctx.get_username(p.uid).padEnd(10)} ${p.state.padEnd(8)} ${p.comm}`);
    return 0;
}

// Display user and group identity.
function whoami(ctx) {
    ctx.printf(ctx.get_username(ctx.geteuid()));
    return 0;
}

function id(ctx) {
    const name = ctx.args[0] ?? ctx.getlogin();
    const pw = ctx.getpwnam(name);
    if (!pw) {
        ctx.perror(`id: '${name}': no such user`);
        return 1;
    }
    const groups = name === ctx.getlogin()
        ? ctx.getgroups()
        : groups_for_user(ctx, name, pw.gid);
    const formatted = groups.map(gid =>
        `${gid}(${ctx.getgrgid(gid)?.name ?? gid})`).join(',');
    const effective = ctx.args[0] === undefined &&
        ctx.geteuid() !== ctx.getuid()
        ? ` euid=${ctx.geteuid()}(${ctx.get_username(ctx.geteuid())})`
        : '';
    ctx.printf(
        `uid=${pw.uid}(${name})${effective} ` +
        `gid=${pw.gid}(${ctx.getgrgid(pw.gid)?.name ?? pw.gid}) ` +
        `groups=${formatted}`);
    return 0;
}

function groups(ctx) {
    const username = ctx.args[0] ?? ctx.getlogin();
    const pw = ctx.getpwnam(username);
    if (!pw) {
        ctx.perror(`groups: '${username}': no such user`);
        return 1;
    }
    const gids = username === ctx.getlogin()
        ? ctx.getgroups()
        : groups_for_user(ctx, username, pw.gid);
    ctx.printf(gids.map(gid => ctx.getgrgid(gid)?.name ?? gid).join(' '));
    return 0;
}

// Manage users, groups, and passwords.
function useradd(ctx) {
    const options = {};
    let name = null;
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-u') options.uid = Number(ctx.args[++i]);
        else if (arg === '-g') options.gid = resolve_group(ctx, ctx.args[++i]);
        else if (arg === '-G') {
            options.groups = ctx.args[++i].split(',')
                .filter(Boolean).map(group => resolve_group(ctx, group));
        } else if (arg === '-d') options.home = ctx.args[++i];
        else if (arg === '-s') options.shell = ctx.args[++i];
        else if (arg === '-c') options.gecos = ctx.args[++i];
        else if (arg === '-p') options.password = ctx.args[++i];
        else if (arg === '-m') { /* Home directories are created by default. */ }
        else if (arg.startsWith('-')) {
            ctx.perror(`useradd: unsupported option '${arg}'`);
            return 1;
        } else name = arg;
    }
    if (!name) {
        ctx.perror('useradd: specify username');
        return 1;
    }
    try {
        ctx.useradd(name, options);
        ctx.success(`useradd: user '${name}' created`);
    } catch (e) {
        ctx.perror(e.errno === EPERM ? 'useradd: Permission denied' : `useradd: ${e.message}`);
        return 1;
    }
    return 0;
}

function usermod(ctx) {
    const options = {};
    let append = false;
    let move_home = false;
    let name = null;
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-u') options.uid = Number(ctx.args[++i]);
        else if (arg === '-g') options.gid = resolve_group(ctx, ctx.args[++i]);
        else if (arg === '-G') {
            options.groups = ctx.args[++i].split(',')
                .filter(Boolean).map(group => resolve_group(ctx, group));
        } else if (arg === '-a' || arg === '-aG') {
            append = true;
            if (arg === '-aG')
                options.groups = ctx.args[++i].split(',')
                    .filter(Boolean).map(group => resolve_group(ctx, group));
        } else if (arg === '-d') options.home = ctx.args[++i];
        else if (arg === '-m') move_home = true;
        else if (arg === '-s') options.shell = ctx.args[++i];
        else if (arg === '-c') options.gecos = ctx.args[++i];
        else if (arg === '-l') options.name = ctx.args[++i];
        else if (arg.startsWith('-')) {
            ctx.perror(`usermod: unsupported option '${arg}'`);
            return 1;
        } else name = arg;
    }
    if (!name) {
        ctx.perror('usermod: specify username');
        return 1;
    }
    options.append = append;
    try {
        const old = ctx.getpwnam(name);
        if (!old) throw new Error(`user '${name}' does not exist`);
        if (move_home && options.home && options.home !== old.home)
            ctx.rename(old.home, options.home);
        ctx.usermod(name, options);
        ctx.success(`usermod: user '${name}' updated`);
    } catch (e) {
        ctx.perror(`usermod: ${e.message}`);
        return 1;
    }
    return 0;
}

function userdel(ctx) {
    const remove_home = ctx.args.includes('-r');
    const name = ctx.args.find(arg => !arg.startsWith('-'));
    if (!name) {
        ctx.perror('userdel: specify username');
        return 1;
    }
    try {
        const entry = ctx.getpwnam(name);
        if (remove_home && entry) {
            try {
                remove_tree(ctx, entry.home);
            } catch (e) {
                if (e.errno !== 2) throw e;
            }
        }
        ctx.userdel(name);
        ctx.success(`userdel: user '${name}' removed`);
    } catch (e) {
        ctx.perror(`userdel: ${e.message}`);
        return 1;
    }
    return 0;
}

function groupadd(ctx) {
    let gid;
    let name;
    for (let i = 0; i < ctx.args.length; i++) {
        if (ctx.args[i] === '-g') gid = Number(ctx.args[++i]);
        else if (!ctx.args[i].startsWith('-')) name = ctx.args[i];
    }
    if (!name) {
        ctx.perror('groupadd: specify group name');
        return 1;
    }
    try {
        ctx.groupadd(name, gid);
        ctx.success(`groupadd: group '${name}' created`);
    } catch (e) {
        ctx.perror(`groupadd: ${e.message}`);
        return 1;
    }
    return 0;
}

function groupdel(ctx) {
    const name = ctx.args[0];
    if (!name) {
        ctx.perror('groupdel: specify group name');
        return 1;
    }
    try {
        ctx.groupdel(name);
        ctx.success(`groupdel: group '${name}' removed`);
    } catch (e) {
        ctx.perror(`groupdel: ${e.message}`);
        return 1;
    }
    return 0;
}

function groupmod(ctx) {
    const options = {};
    let name;
    for (let i = 0; i < ctx.args.length; i++) {
        if (ctx.args[i] === '-g') options.gid = Number(ctx.args[++i]);
        else if (ctx.args[i] === '-n') options.name = ctx.args[++i];
        else if (!ctx.args[i].startsWith('-')) name = ctx.args[i];
    }
    if (!name) {
        ctx.perror('groupmod: specify group name');
        return 1;
    }
    try {
        ctx.groupmod(name, options);
        ctx.success(`groupmod: group '${name}' updated`);
    } catch (e) {
        ctx.perror(`groupmod: ${e.message}`);
        return 1;
    }
    return 0;
}

function gpasswd(ctx) {
    const operation = ctx.args[0];
    const username = ctx.args[1];
    const group = ctx.args[2];
    if (!['-a', '-d'].includes(operation) || !username || !group) {
        ctx.perror('usage: gpasswd -a|-d USER GROUP');
        return 1;
    }
    try {
        ctx.groupmem(group, username, operation === '-a');
        ctx.success(
            operation === '-a'
                ? `Adding user ${username} to group ${group}`
                : `Removing user ${username} from group ${group}`);
    } catch (e) {
        ctx.perror(`gpasswd: ${e.message}`);
        return 1;
    }
    return 0;
}

function passwd(ctx) {
    const [name, pw] = ctx.args;
    try {
        ctx.passwd(name ?? ctx.getlogin(), pw ?? 'changeme');
        ctx.success(`passwd: updated for '${name ?? ctx.getlogin()}'`);
    } catch (e) {
        ctx.perror(`passwd: ${e.message}`);
        return 1;
    }
    return 0;
}

function users(ctx) {
    ctx.printf(ctx.getusers().join(' '));
    return 0;
}

function getent(ctx) {
    const database = ctx.args[0];
    const key = ctx.args[1];
    if (!['passwd', 'group'].includes(database)) {
        ctx.perror('getent: supported databases: passwd, group');
        return 1;
    }
    try {
        const lines = ctx.read(`/etc/${database}`).trim().split('\n');
        const selected = key === undefined
            ? lines
            : lines.filter(line => {
                const fields = line.split(':');
                return fields[0] === key ||
                    fields[database === 'passwd' ? 2 : 2] === key;
            });
        for (const line of selected) ctx.printf(line);
        return selected.length ? 0 : 2;
    } catch (e) {
        ctx.perror(`getent: ${e.message}`);
        return 1;
    }
}

function who(ctx) {
    ctx.dim('USER       TTY      LOGIN@');
    ctx.printf(`${ctx.getlogin().padEnd(10)} pts/0    ${new Date(ksyms.boot_time).toLocaleTimeString()}`);
    return 0;
}

// Display system information.
function uname(ctx) {
    const {flags} = parse_flags(ctx.args);
    const u = ctx.uname();
    ctx.printf(flags.has('a') ? `${u.sysname} ${u.nodename} ${u.release} ${u.version} ${u.machine}`
        : flags.has('r') ? u.release
            : flags.has('m') ? u.machine
                : u.sysname);
    return 0;
}

function uptime(ctx) {
    const i = ctx.sysinfo();
    ctx.printf(` up ${fmt_uptime(i.uptime)},  1 user,  load average: 0.01, 0.01, 0.00`);
    return 0;
}

function date(ctx) {
    ctx.printf(new Date().toString());
    return 0;
}

function hostname(ctx) {
    try {
        if (ctx.args.length) {
            ctx.write('/etc/hostname', ctx.args[0] + '\n');
            return 0;
        }
        ctx.printf(ctx.read('/etc/hostname').trim());
    } catch (e) {
        ctx.perror(`hostname: ${e.message}`);
        return 1;
    }
    return 0;
}

function jsnix_js(ctx) {
    const script = ctx.args[0];
    if (!script) {
        ctx.perror('jsnix-js: missing script file');
        return 2;
    }

    let image;
    try {
        image = parse_js_script_image(ctx.read(ctx.realpath(script)));
    } catch (error) {
        ctx.perror(`jsnix-js: ${script}: ${error.message}`);
        return 126;
    }

    const script_path = ctx.realpath(script);
    const script_ctx = Object.freeze({
        ...ctx,
        argv: [script_path, ...ctx.args.slice(1)],
        args: ctx.args.slice(1),
    });

    try {
        let status;
        const source = image.source.trim();
        if (/^(?:async\s+)?function\b/.test(source) ||
            /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source)) {
            status = compile_program_image(image)(script_ctx);
        } else {
            const scope = Object.create(globalThis);
            scope.ctx = script_ctx;
            scope.alert = typeof globalThis.alert === 'function'
                ? globalThis.alert.bind(globalThis)
                : script_ctx.printf;
            scope.console = {
                log: script_ctx.printf,
                error: script_ctx.perror,
                warn: script_ctx.warn,
                info: script_ctx.info,
            };
            status = Function(
                'scope',
                `with (scope) {\n${source}\n}`,
            )(scope);
        }
        return Number.isInteger(status) ? status : Number(status) || 0;
    } catch (error) {
        ctx.perror(`jsnix-js: ${script}: ${error.message}`);
        return 1;
    }
}

// Display environment variables.
function env(ctx) {
    const args = [...ctx.args];
    while (args[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/)) {
        const assignment = args.shift();
        const equals = assignment.indexOf('=');
        ctx.setenv(assignment.slice(0, equals), assignment.slice(equals + 1));
    }
    if (args.length) {
        const result = ctx.run(args);
        if (!result) {
            ctx.perror(`env: '${args[0]}': No such file or directory`);
            return 127;
        }
        ctx.stdout_buf.push(...result.stdout_buf);
        ctx.stderr_buf.push(...result.stderr_buf);
        return result.exit_code;
    }

    const snap = ksyms.get_task(ctx.getpid());
    for (const [k, v] of Object.entries(snap?.envp ?? {})) ctx.printf(`${k}=${v}`);
    return 0;
}

function printenv(ctx) {
    const snap = ksyms.get_task(ctx.getpid());
    const env = snap?.envp ?? {};
    if (ctx.args.length) {
        for (const k of ctx.args) ctx.printf(env[k] ?? '');
    } else {
        for (const [k, v] of Object.entries(env)) ctx.printf(`${k}=${v}`);
    }
    return 0;
}

function basename(ctx) {
    if (!ctx.args.length) {
        ctx.perror('basename: missing operand');
        return 1;
    }
    const path = ctx.args[0].replace(/\/+$/, '') || '/';
    let name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    const suffix = ctx.args[1];
    if (suffix && name.endsWith(suffix))
        name = name.slice(0, -suffix.length);
    ctx.printf(name);
    return 0;
}

function dirname(ctx) {
    if (!ctx.args.length) {
        ctx.perror('dirname: missing operand');
        return 1;
    }
    const path = ctx.args[0].replace(/\/+$/, '') || '/';
    const slash = path.lastIndexOf('/');
    ctx.printf(slash <= 0 ? (slash === 0 ? '/' : '.') : path.slice(0, slash));
    return 0;
}

function printf(ctx) {
    if (!ctx.args.length) return 0;
    let arg_index = 1;
    const output = ctx.args[0].replace(
        /%(%|s|d)|\\([nrt\\])/g,
        (_, format, escape) => {
            if (escape) return {
                n: '\n', r: '\r', t: '\t', '\\': '\\',
            }[escape];
            if (format === '%') return '%';
            const value = ctx.args[arg_index++] ?? '';
            return format === 'd' ? String(Number(value) || 0) : value;
        });
    emit_text(ctx, output);
    return 0;
}

function sort(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    let content = ctx.stdin;
    try {
        if (positional.length)
            content = positional.map(file => ctx.read(ctx.realpath(file))).join('');
    } catch (e) {
        ctx.perror(`sort: ${e.message}`);
        return 1;
    }
    let lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.sort(flags.has('n')
        ? (a, b) => Number(a) - Number(b)
        : (a, b) => a.localeCompare(b));
    if (flags.has('u')) lines = [...new Set(lines)];
    if (flags.has('r')) lines.reverse();
    for (const line of lines) ctx.printf(line);
    return 0;
}

function uniq(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    let content = ctx.stdin;
    try {
        if (positional[0]) content = ctx.read(ctx.realpath(positional[0]));
    } catch (e) {
        ctx.perror(`uniq: ${e.message}`);
        return 1;
    }
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (let i = 0; i < lines.length;) {
        let end = i + 1;
        while (end < lines.length && lines[end] === lines[i]) end++;
        const count = end - i;
        if (!flags.has('d') || count > 1)
            ctx.printf(`${flags.has('c') ? String(count).padStart(7) + ' ' : ''}${lines[i]}`);
        i = end;
    }
    return 0;
}

function cut(ctx) {
    let delimiter = '\t';
    let fields = null;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        if (arg === '-d') delimiter = ctx.args[++i] ?? '';
        else if (arg.startsWith('-d')) delimiter = arg.slice(2);
        else if (arg === '-f') fields = ctx.args[++i];
        else if (arg.startsWith('-f')) fields = arg.slice(2);
        else files.push(arg);
    }
    if (!fields) {
        ctx.perror('cut: you must specify a list of fields');
        return 1;
    }
    const selected = fields.split(',').map(Number);
    try {
        const content = files.length
            ? files.map(file => ctx.read(ctx.realpath(file))).join('')
            : ctx.stdin;
        for (const line of content.split('\n')) {
            if (!line && content.endsWith('\n')) continue;
            const columns = line.split(delimiter);
            ctx.printf(selected.map(field => columns[field - 1] ?? '').join(delimiter));
        }
    } catch (e) {
        ctx.perror(`cut: ${e.message}`);
        return 1;
    }
    return 0;
}

function tr(ctx) {
    const remove = ctx.args[0] === '-d';
    const args = remove ? ctx.args.slice(1) : ctx.args;
    if (!args.length) {
        ctx.perror('tr: missing operand');
        return 1;
    }
    const expand = value => value.replace(
        /(.)-(.)/g,
        (_, start, end) => {
            let result = '';
            for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code++)
                result += String.fromCharCode(code);
            return result;
        });
    const source = expand(args[0]);
    const target = expand(args[1] ?? '');
    let result = '';
    for (const char of ctx.stdin) {
        const index = source.indexOf(char);
        if (index < 0) result += char;
        else if (!remove) result += target[index] ?? target.at(-1) ?? '';
    }
    emit_text(ctx, result);
    return 0;
}

function tee(ctx) {
    const {flags, positional} = parse_flags(ctx.args);
    let rc = 0;
    for (const file of positional) {
        try {
            ctx.write(ctx.realpath(file), ctx.stdin, flags.has('a'));
        } catch (e) {
            ctx.perror(`tee: ${file}: ${e.message}`);
            rc = 1;
        }
    }
    emit_text(ctx, ctx.stdin);
    return rc;
}

function seq(ctx) {
    const values = ctx.args.map(Number);
    if (!values.length || values.some(Number.isNaN)) {
        ctx.perror('seq: invalid operand');
        return 1;
    }
    const first = values.length === 1 ? 1 : values[0];
    const step = values.length === 3 ? values[1] : 1;
    const last = values.at(-1);
    if (step === 0) {
        ctx.perror('seq: zero increment');
        return 1;
    }
    for (let value = first;
         step > 0 ? value <= last : value >= last;
         value += step)
        ctx.printf(value);
    return 0;
}

function which(ctx) {
    let rc = 0;
    for (const command of ctx.args) {
        const path = ctx.get_binary_path(command);
        if (path) ctx.printf(path);
        else {
            ctx.perror(`${command} not found`);
            rc = 1;
        }
    }
    return rc;
}

function type(ctx) {
    let rc = 0;
    for (const command of ctx.args) {
        if (is_shell_reserved_word(command))
            ctx.printf(`${command} is a shell keyword`);
        else if (is_shell_builtin(command))
            ctx.printf(`${command} is a shell builtin`);
        else if (ctx.get_binary_path(command))
            ctx.printf(`${command} is ${ctx.get_binary_path(command)}`);
        else {
            ctx.perror(`type: ${command}: not found`);
            rc = 1;
        }
    }
    return rc;
}

function tree(ctx) {
    const root = ctx.realpath(ctx.args[0] ?? '.');
    try {
        const print = (path, prefix) => {
            const children = ctx.readdir(path);
            children.forEach((child, index) => {
                const last = index === children.length - 1;
                ctx.printf(`${prefix}${last ? '└── ' : '├── '}${child}`);
                const child_path = path === '/' ? `/${child}` : `${path}/${child}`;
                if (ctx.lstat(child_path).type === 'dir')
                    print(child_path, prefix + (last ? '    ' : '│   '));
            });
        };
        ctx.printf(root);
        print(root, '');
    } catch (e) {
        ctx.perror(`tree: ${e.message}`);
        return 1;
    }
    return 0;
}

function du(ctx) {
    const paths = ctx.args.filter(arg => !arg.startsWith('-'));
    if (!paths.length) paths.push('.');
    try {
        for (const path of paths) {
            const abs = ctx.realpath(path);
            let size = 0;
            walk_tree(ctx, abs, (_target, stat) => size += stat.st_size);
            ctx.printf(`${Math.max(1, Math.ceil(size / 1024))}\t${path}`);
        }
    } catch (e) {
        ctx.perror(`du: ${e.message}`);
        return 1;
    }
    return 0;
}

function true_cmd() {
    return 0;
}

function false_cmd() {
    return 1;
}

// Suspend execution for an interval.
async function sleep(ctx) {
    const values = ctx.args.length ? ctx.args : ['0'];
    let total_ms = 0;
    for (const value of values) {
        const match = String(value).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
        if (!match) {
            ctx.perror(`sleep: invalid time interval '${value}'`);
            return 1;
        }
        const scalar = Number(match[1]);
        const unit = match[2] || 's';
        const multiplier = {
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
        }[unit];
        total_ms += scalar * multiplier;
    }
    return await ctx.sleep(total_ms) ? 0 : 128 + 15;
}

// Display the kernel log.
function dmesg(ctx) {
    try {
        const log = ctx.read('/var/log/kern.log');
        for (const l of log.trim().split('\n')) ctx.info(l);
    } catch (e) {
        ctx.perror(`dmesg: ${e.message}`);
        return 1;
    }
    return 0;
}

// Display memory and file system usage.
function free(ctx) {
    const i = ctx.sysinfo();
    ctx.dim('              total        used        free');
    ctx.printf(`Mem:        ${i.totalram}      ${i.totalram - i.freeram}      ${i.freeram}`);
    ctx.printf('Swap:             0           0           0');
    return 0;
}

function df(ctx) {
    ctx.dim('Filesystem     1K-blocks  Used Available Use% Mounted on');
    ctx.printf('jsfs             1048576  2048   1046528   1% /');
    ctx.printf('proc                   0     0         0   -  /proc');
    return 0;
}

// Clear the terminal.
function clear(ctx) {
    ctx.special('clear');
    return 0;
}

// Display command history.
function history(ctx) {
    let hist;
    try {
        hist = JSON.parse(ctx.stdin);
    } catch {
        hist = [];
    }
    hist.forEach((cmd, i) => ctx.printf(`  ${String(i + 1).padStart(4)}  ${cmd}`));
    return 0;
}

register_binary('ls', ls);
register_binary('pwd', pwd);
register_binary('cat', cat);
register_binary('echo', echo);
register_binary('touch', touch);
register_binary('mkdir', mkdir);
register_binary('rmdir', rmdir);
register_binary('rm', rm);
register_binary('mv', mv);
register_binary('cp', cp);
register_binary('chmod', chmod);
register_binary('chown', chown);
register_binary('chgrp', chgrp);
register_binary('stat', stat);
register_binary('find', find);
register_binary('grep', grep);
register_binary('wc', wc);
register_binary('head', head);
register_binary('tail', tail);
register_binary('ps', ps);
register_binary('kill', kill);
register_binary('top', top);
register_binary('whoami', whoami);
register_binary('id', id);
register_binary('groups', groups);
register_binary('useradd', useradd);
register_binary('usermod', usermod);
register_binary('userdel', userdel);
register_binary('groupadd', groupadd);
register_binary('groupdel', groupdel);
register_binary('groupmod', groupmod);
register_binary('gpasswd', gpasswd);
register_binary('passwd', passwd);
register_binary('users', users);
register_binary('getent', getent);
register_binary('who', who);
register_binary('uname', uname);
register_binary('uptime', uptime);
register_binary('date', date);
register_binary('hostname', hostname);
register_binary('jsnix-js', jsnix_js);
register_binary('env', env);
register_binary('printenv', printenv);
register_binary('basename', basename);
register_binary('dirname', dirname);
register_binary('printf', printf);
register_binary('sort', sort);
register_binary('uniq', uniq);
register_binary('cut', cut);
register_binary('tr', tr);
register_binary('tee', tee);
register_binary('seq', seq);
register_binary('which', which);
register_binary('type', type);
register_binary('tree', tree);
register_binary('du', du);
register_binary('true', true_cmd);
register_binary('false', false_cmd);
register_binary('sleep', sleep);
register_binary('dmesg', dmesg);
register_binary('free', free);
register_binary('df', df);
register_binary('clear', clear);
register_binary('history', history);
