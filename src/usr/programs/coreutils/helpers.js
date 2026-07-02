/**
 * usr/programs/coreutils/helpers.js - Shared coreutils helpers
 */

'use strict';

import {
    S_IRGRP,
    S_IROTH,
    S_IRUSR,
    S_ISCHR,
    S_ISDIR,
    S_ISGID,
    S_ISLNK,
    S_ISUID,
    S_ISVTX,
    S_IWGRP,
    S_IWOTH,
    S_IWUSR,
    S_IXGRP,
    S_IXOTH,
    S_IXUSR,
} from '../../../kernel/include/types.js';

export function strmode(mode) {
    const type = S_ISDIR(mode) ? 'd'
        : S_ISLNK(mode) ? 'l'
            : S_ISCHR(mode) ? 'c'
                : '-';
    const b = (n, c) => (mode & n) ? c : '-';
    const sx = (exec_bit, special_bit, lower, upper) =>
        mode & special_bit
            ? mode & exec_bit ? lower : upper
            : b(exec_bit, 'x');
    return type
        + b(S_IRUSR, 'r') + b(S_IWUSR, 'w') + sx(S_IXUSR, S_ISUID, 's', 'S')
        + b(S_IRGRP, 'r') + b(S_IWGRP, 'w') + sx(S_IXGRP, S_ISGID, 's', 'S')
        + b(S_IROTH, 'r') + b(S_IWOTH, 'w') + sx(S_IXOTH, S_ISVTX, 't', 'T');
}

export function parse_flags(args) {
    const flags = new Set(), positional = [];
    for (const a of args) {
        if (a === '--') break;
        if (a.startsWith('-') && a.length > 1 && !a.startsWith('--'))
            for (const c of a.slice(1)) flags.add(c);
        else
            positional.push(a);
    }
    return {flags, positional};
}

export function fmt_uptime(secs) {
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600),
        m = Math.floor((secs % 3600) / 60), s = secs % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

export function emit_text(ctx, content) {
    const lines = String(content).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) ctx.printf(line);
}

export function resolve_user(ctx, value) {
    if (value === undefined || value === '') return -1;
    if (/^\d+$/.test(value)) return Number(value);
    const entry = ctx.getpwnam(value);
    if (!entry) throw new Error(`invalid user: '${value}'`);
    return entry.uid;
}

export function resolve_group(ctx, value) {
    if (value === undefined || value === '') return -1;
    if (/^\d+$/.test(value)) return Number(value);
    const entry = ctx.getgrnam(value);
    if (!entry) throw new Error(`invalid group: '${value}'`);
    return entry.gid;
}

export function walk_tree(ctx, abs, visit, post_order = false) {
    const stat = ctx.lstat(abs);
    if (!post_order) visit(abs, stat);
    if (stat.type === 'dir') {
        for (const child of ctx.readdir(abs))
            walk_tree(ctx, abs === '/' ? `/${child}` : `${abs}/${child}`,
                visit, post_order);
    }
    if (post_order) visit(abs, stat);
}

export function remove_tree(ctx, abs) {
    walk_tree(ctx, abs, (path, stat) => {
        if (stat.type === 'dir') ctx.rmdir(path);
        else ctx.unlink(path);
    }, true);
}

export function copy_tree(ctx, source, destination) {
    const stat = ctx.lstat(source);
    if (stat.type === 'link') {
        ctx.symlink(ctx.readlink(source), destination);
        return;
    }
    if (stat.type === 'dir') {
        try {
            ctx.mkdir(destination, stat.st_mode & 0o7777);
        } catch (e) {
            if (e.errno !== 17) throw e;
        }
        for (const child of ctx.readdir(source))
            copy_tree(
                ctx,
                source === '/' ? `/${child}` : `${source}/${child}`,
                destination === '/' ? `/${child}` : `${destination}/${child}`
            );
        return;
    }
    ctx.write(destination, ctx.read(source));
    ctx.chmod(destination, stat.st_mode & 0o7777);
}

export function parse_symbolic_mode(spec, current_mode, is_dir) {
    let mode = current_mode & 0o7777;
    for (const clause of spec.split(',')) {
        const match = clause.match(/^([ugoa]*)([+=-])([rwxXst]*)$/);
        if (!match) throw new Error(`invalid mode: '${spec}'`);
        const who = match[1] || 'a';
        const op = match[2];
        const perms = match[3];
        const classes = who.includes('a') ? 'ugo' : who;
        let bits = 0;

        for (const cls of classes) {
            const shift = cls === 'u' ? 6 : cls === 'g' ? 3 : 0;
            if (perms.includes('r')) bits |= 4 << shift;
            if (perms.includes('w')) bits |= 2 << shift;
            if (perms.includes('x') ||
                (perms.includes('X') && (is_dir || mode & 0o111)))
                bits |= 1 << shift;
            if (perms.includes('s') && cls === 'u') bits |= S_ISUID;
            if (perms.includes('s') && cls === 'g') bits |= S_ISGID;
            if (perms.includes('t') && cls === 'o') bits |= S_ISVTX;
        }

        let clear = 0;
        for (const cls of classes) {
            clear |= cls === 'u' ? 0o4700 : cls === 'g' ? 0o2070 : 0o1007;
        }
        if (op === '=') mode = (mode & ~clear) | bits;
        else if (op === '+') mode |= bits;
        else mode &= ~bits;
    }
    return mode;
}

export function read_group_entries(ctx) {
    return ctx.read('/etc/group').trim().split('\n').filter(Boolean).map(line => {
        const [name, , gid, members = ''] = line.split(':');
        return {
            name,
            gid: Number(gid),
            members: members ? members.split(',') : [],
            line,
        };
    });
}

export function groups_for_user(ctx, username, primary_gid) {
    const gids = [primary_gid];
    for (const group of read_group_entries(ctx)) {
        if (group.members.includes(username)) gids.push(group.gid);
    }
    return [...new Set(gids)];
}

export function file_role(stat) {
    if (stat.type === 'dir') return 'directory';
    if (stat.type === 'link') return 'symlink';
    if (stat.type === 'char') return 'device';
    if (stat.st_mode & 0o111) return 'executable';
    return 'file';
}
