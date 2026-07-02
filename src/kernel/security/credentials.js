'use strict';

import {EEXIST, EINVAL, ENOENT, EPERM, ROOT_GID, ROOT_UID} from '../include/types.js';
import {path_lookup} from '../fs/vfs.js';

const user_db = {};
const group_db = {};

export function credentials_reset() {
    for (const key of Object.keys(user_db)) delete user_db[key];
    for (const key of Object.keys(group_db)) delete group_db[key];
}

function file_data(path) {
    const inode = path_lookup(path);
    return inode?.i_type === 'file' ? String(inode.i_data ?? '') : null;
}

function account_files_ready() {
    return file_data('/etc/passwd') !== null &&
        file_data('/etc/group') !== null &&
        file_data('/etc/shadow') !== null;
}

function parse_passwd(content) {
    return String(content).split('\n')
        .filter(Boolean)
        .map(line => line.split(':'))
        .filter(fields => fields.length >= 7)
        .map(fields => ({
            username: fields[0],
            pw_hash: fields[1],
            uid: Number(fields[2]),
            gid: Number(fields[3]),
            gecos: fields[4],
            home: fields[5],
            shell: fields[6],
        }))
        .filter(entry =>
            entry.username &&
            Number.isInteger(entry.uid) &&
            Number.isInteger(entry.gid));
}

function parse_shadow(content) {
    const shadow = new Map();
    for (const line of String(content).split('\n').filter(Boolean)) {
        const fields = line.split(':');
        if (fields[0]) shadow.set(fields[0], fields[1] ?? '!');
    }
    return shadow;
}

function parse_group(content) {
    return String(content).split('\n')
        .filter(Boolean)
        .map(line => line.split(':'))
        .filter(fields => fields.length >= 4)
        .map(fields => ({
            name: fields[0],
            gid: Number(fields[2]),
            members: fields[3] ? fields[3].split(',').filter(Boolean) : [],
        }))
        .filter(entry => entry.name && Number.isInteger(entry.gid));
}

export function load_account_files() {
    if (!account_files_ready()) return false;

    const passwd_entries = parse_passwd(file_data('/etc/passwd'));
    const shadow_entries = parse_shadow(file_data('/etc/shadow'));
    const group_entries = parse_group(file_data('/etc/group'));

    credentials_reset();
    for (const group of group_entries) group_db_insert(group);
    for (const entry of passwd_entries) {
        const shadow_hash = shadow_entries.get(entry.username);
        const locked = shadow_hash === undefined ||
            shadow_hash === '' ||
            shadow_hash.startsWith('!') ||
            shadow_hash.startsWith('*');
        user_db[entry.username] = {
            ...entry,
            groups: [entry.gid],
            shadow_hash: shadow_hash ?? '!',
            locked,
        };
    }
    for (const [name, group] of Object.entries(group_db)) {
        for (const username of group.members) {
            const user = user_db[username];
            if (!user) continue;
            user.groups = unique_ids([...user.groups, group.gid]);
        }
        for (const user of Object.values(user_db)) {
            if (user.gid !== group.gid || group.members.includes(user.username))
                continue;
            group.members.push(user.username);
        }
        group_db[name].members = [...new Set(group.members)];
    }
    return true;
}

function refresh_account_files() {
    load_account_files();
}

function public_entry(username, entry) {
    if (!entry) return null;
    const {
        locked: _locked,
        pw_hash: _pw_hash,
        shadow_hash: _shadow_hash,
        ...safe
    } = entry;
    return {username, ...safe};
}

function public_group(name, entry) {
    return entry ? {name, gid: entry.gid, members: [...entry.members]} : null;
}

function unique_ids(ids) {
    return [...new Set(ids.map(Number).filter(Number.isInteger))];
}

function raw_uid_to_username(uid) {
    return Object.keys(user_db).find(n => user_db[n].uid === uid) ?? String(uid);
}

function raw_gid_to_groupname(gid) {
    return Object.keys(group_db).find(n => group_db[n].gid === gid) ?? String(gid);
}

export function uid_to_username(uid) {
    refresh_account_files();
    return raw_uid_to_username(uid);
}

export function uid_to_home(uid) {
    refresh_account_files();
    return user_db[raw_uid_to_username(uid)]?.home ?? '/';
}

export function getpwnam(name) {
    refresh_account_files();
    return public_entry(name, user_db[name]);
}

export function getpwuid(uid) {
    refresh_account_files();
    const username = raw_uid_to_username(uid);
    return public_entry(username, user_db[username]);
}

export function list_users() {
    refresh_account_files();
    return Object.keys(user_db);
}

export function gid_to_groupname(gid) {
    refresh_account_files();
    return raw_gid_to_groupname(gid);
}

export function getgrnam(name) {
    refresh_account_files();
    return public_group(name, group_db[name]);
}

export function getgrgid(gid) {
    refresh_account_files();
    return public_group(raw_gid_to_groupname(gid), group_db[raw_gid_to_groupname(gid)]);
}

export function list_groups() {
    refresh_account_files();
    return Object.keys(group_db);
}

export function user_groups(uid) {
    refresh_account_files();
    return getpwuid(uid)?.groups ?? [];
}

function group_db_insert(entry) {
    group_db[entry.name] = {
        gid: entry.gid,
        members: [...new Set(entry.members ?? [])],
    };
}

export function sys_useradd(caller_uid, username, options = {}) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    if (user_db[username]) return -EEXIST;
    if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(username)) return -EINVAL;

    const uid = options.uid ?? _next_uid();
    if (!Number.isInteger(uid) || uid < 0) return -EINVAL;
    if (Object.values(user_db).some(u => u.uid === uid)) return -EEXIST;

    let gid = options.gid;
    let create_private_group = false;
    if (gid === undefined || gid === null) {
        gid = _next_gid();
        create_private_group = true;
    } else if (!Number.isInteger(gid) || gid < 0) {
        return -EINVAL;
    } else if (!group_db[raw_gid_to_groupname(gid)]) {
        return -ENOENT;
    }

    if ((options.groups ?? []).some(
        group_id => !Number.isInteger(group_id) || group_id < 0))
        return -EINVAL;
    const supplemental = unique_ids(options.groups ?? []);
    if (supplemental.some(group_id => !group_db[raw_gid_to_groupname(group_id)]))
        return -ENOENT;

    if (create_private_group)
        group_db[username] = {gid, members: [username]};
    const groups = unique_ids([gid, ...supplemental]);
    user_db[username] = {
        uid,
        gid,
        groups,
        gecos: options.gecos ?? username,
        home: options.home ?? `/home/${username}`,
        shell: options.shell ?? '/bin/sh',
        pw_hash: 'x',
        shadow_hash: options.password ? simulated_shadow_hash(options.password) : '!',
        locked: !options.password,
    };
    for (const group_id of groups) _add_group_member(group_id, username);
    sync_passwd();
    sync_group();
    sync_shadow();
    auth_log(`useradd: new user '${username}' uid=${uid}`);
    return 0;
}

export function sys_userdel(caller_uid, username) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    if (!user_db[username]) return -ENOENT;
    if (username === 'root') return -EPERM;
    const old = user_db[username];
    delete user_db[username];
    for (const group of Object.values(group_db))
        group.members = group.members.filter(member => member !== username);
    if (group_db[username]?.gid === old.gid &&
        !Object.values(user_db).some(user => user.gid === old.gid))
        delete group_db[username];
    sync_passwd();
    sync_group();
    sync_shadow();
    auth_log(`userdel: deleted user '${username}'`);
    return 0;
}

export function sys_usermod(caller_uid, username, options = {}) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    const user = user_db[username];
    if (!user) return -ENOENT;
    if (username === 'root' && options.name && options.name !== 'root') return -EPERM;

    const new_name = options.name ?? username;
    if (new_name !== username && user_db[new_name]) return -EEXIST;
    if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(new_name)) return -EINVAL;

    if (options.uid !== undefined &&
        (!Number.isInteger(options.uid) || options.uid < 0))
        return -EINVAL;
    if (options.uid !== undefined &&
        Object.entries(user_db).some(([name, u]) => name !== username && u.uid === options.uid))
        return -EEXIST;
    if (options.gid !== undefined &&
        (!Number.isInteger(options.gid) || options.gid < 0))
        return -EINVAL;
    if (options.gid !== undefined && !group_db[raw_gid_to_groupname(options.gid)])
        return -ENOENT;

    let groups = user.groups.filter(gid => gid !== user.gid);
    if (options.groups !== undefined) {
        if (options.groups.some(
            gid => !Number.isInteger(gid) || gid < 0))
            return -EINVAL;
        if (options.groups.some(gid => !group_db[raw_gid_to_groupname(gid)]))
            return -ENOENT;
        groups = options.append
            ? unique_ids([...groups, ...options.groups])
            : unique_ids(options.groups);
    }

    for (const group of Object.values(group_db))
        group.members = group.members.filter(member => member !== username);

    const updated = {
        ...user,
        uid: options.uid ?? user.uid,
        gid: options.gid ?? user.gid,
        groups: unique_ids([options.gid ?? user.gid, ...groups]),
        gecos: options.gecos ?? user.gecos,
        home: options.home ?? user.home,
        shell: options.shell ?? user.shell,
    };

    if (new_name !== username) delete user_db[username];
    user_db[new_name] = updated;
    for (const gid of updated.groups) _add_group_member(gid, new_name);

    sync_passwd();
    sync_group();
    sync_shadow();
    auth_log(`usermod: updated user '${username}'${new_name !== username ? ` -> '${new_name}'` : ''}`);
    return 0;
}

export function sys_passwd(caller_uid, username, new_pw) {
    refresh_account_files();
    const entry = user_db[username];
    if (!entry) return -ENOENT;
    if (typeof new_pw !== 'string') return -EINVAL;
    if (caller_uid !== ROOT_UID && raw_uid_to_username(caller_uid) !== username)
        return -EPERM;
    entry.pw_hash = 'x';
    entry.shadow_hash = simulated_shadow_hash(new_pw);
    entry.locked = false;
    sync_shadow();
    auth_log(`passwd: password changed for '${username}'`);
    return 0;
}

export function authenticate(username, password) {
    refresh_account_files();
    const entry = user_db[username];
    if (!entry || entry.locked) return null;
    const plain = String(password);
    const shadow = entry.shadow_hash ?? '';
    const matches = shadow.startsWith('$6$jsnix$')
        ? shadow === simulated_shadow_hash(plain)
        : shadow === plain || entry.pw_hash === plain;
    if (!matches) return null;
    return public_entry(username, entry);
}

export function sys_groupadd(caller_uid, name, gid) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(name)) return -EINVAL;
    if (group_db[name]) return -EEXIST;
    gid = gid ?? _next_gid();
    if (!Number.isInteger(gid) || gid < 0) return -EINVAL;
    if (group_db[raw_gid_to_groupname(gid)]) return -EEXIST;
    group_db[name] = {gid, members: []};
    sync_group();
    auth_log(`groupadd: new group '${name}' gid=${gid}`);
    return 0;
}

export function sys_groupdel(caller_uid, name) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    const group = group_db[name];
    if (!group) return -ENOENT;
    if (group.gid === ROOT_GID ||
        Object.values(user_db).some(user => user.gid === group.gid))
        return -EPERM;
    delete group_db[name];
    for (const user of Object.values(user_db))
        user.groups = user.groups.filter(gid => gid !== group.gid);
    sync_group();
    sync_passwd();
    auth_log(`groupdel: deleted group '${name}'`);
    return 0;
}

export function sys_groupmod(caller_uid, name, options = {}) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    const group = group_db[name];
    if (!group) return -ENOENT;
    const new_name = options.name ?? name;
    if (new_name !== name && group_db[new_name]) return -EEXIST;
    if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(new_name)) return -EINVAL;
    if (options.gid !== undefined &&
        (!Number.isInteger(options.gid) || options.gid < 0))
        return -EINVAL;
    if (options.gid !== undefined &&
        Object.entries(group_db).some(([n, g]) => n !== name && g.gid === options.gid))
        return -EEXIST;

    const old_gid = group.gid;
    group.gid = options.gid ?? group.gid;
    if (new_name !== name) {
        delete group_db[name];
        group_db[new_name] = group;
    }
    if (group.gid !== old_gid) {
        for (const user of Object.values(user_db)) {
            if (user.gid === old_gid) user.gid = group.gid;
            user.groups = user.groups.map(gid => gid === old_gid ? group.gid : gid);
        }
    }
    sync_group();
    sync_passwd();
    auth_log(`groupmod: updated group '${name}'`);
    return 0;
}

export function sys_group_member(caller_uid, group_name, username, add) {
    refresh_account_files();
    if (caller_uid !== ROOT_UID) return -EPERM;
    const group = group_db[group_name];
    const user = user_db[username];
    if (!group || !user) return -ENOENT;
    if (!add && user.gid === group.gid) return -EPERM;

    if (add) {
        _add_group_member(group.gid, username);
        user.groups = unique_ids([...user.groups, group.gid]);
    } else {
        group.members = group.members.filter(member => member !== username);
        user.groups = user.groups.filter(gid => gid !== group.gid);
    }
    sync_group();
    sync_passwd();
    return 0;
}

export function sync_passwd() {
    const inode = path_lookup('/etc/passwd');
    if (!inode) return;
    inode.i_data = Object.entries(user_db)
        .map(([n, u]) => `${n}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`)
        .join('\n') + '\n';
    inode.i_mtime = inode.i_ctime = Date.now();
}

export function sync_group() {
    const inode = path_lookup('/etc/group');
    if (!inode) return;
    inode.i_data = Object.entries(group_db)
        .map(([name, group]) =>
            `${name}:x:${group.gid}:${group.members.join(',')}`)
        .join('\n') + '\n';
    inode.i_mtime = inode.i_ctime = Date.now();
    sync_gshadow();
}

export function sync_shadow() {
    const inode = path_lookup('/etc/shadow');
    if (!inode) return;
    inode.i_data = Object.entries(user_db)
        .map(([name, user]) =>
            `${name}:${user.locked ? '!' : user.shadow_hash ?? simulated_shadow_hash(user.pw_hash)}:19000:0:99999:7:::`)
        .join('\n') + '\n';
    inode.i_mtime = inode.i_ctime = Date.now();
}

export function sync_gshadow() {
    const inode = path_lookup('/etc/gshadow');
    if (!inode) return;
    inode.i_data = Object.entries(group_db)
        .map(([name, group]) =>
            `${name}:!::${group.members.join(',')}`)
        .join('\n') + '\n';
    inode.i_mtime = inode.i_ctime = Date.now();
}

function auth_log(msg) {
    const inode = path_lookup('/var/log/auth.log');
    if (inode) inode.i_data += `${new Date().toISOString()} jsnix ${msg}\n`;
}

function _next_uid() {
    const allocated = Object.values(user_db)
        .map(user => user.uid)
        .filter(uid => uid >= 1000 && uid < 60000);
    return Math.max(999, ...allocated) + 1;
}

function _next_gid() {
    const allocated = Object.values(group_db)
        .map(group => group.gid)
        .filter(gid => gid >= 1000 && gid < 60000);
    return Math.max(999, ...allocated) + 1;
}

export function make_shadow_hash(password) {
    let hash = 2166136261;
    for (const char of String(password)) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    const digest = hash.toString(16).padStart(8, '0').repeat(11).slice(0, 86);
    return `$6$jsnix$${digest}`;
}

const simulated_shadow_hash = make_shadow_hash;

function _add_group_member(gid, username) {
    const name = raw_gid_to_groupname(gid);
    const group = group_db[name];
    if (group && !group.members.includes(username)) group.members.push(username);
}
