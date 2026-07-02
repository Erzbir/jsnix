'use strict';

import {printk} from '../../kernel/syscall/dispatcher.js';
import {
    load_account_files,
    make_shadow_hash,
} from '../../kernel/security/credentials.js';
import {
    list_binary_entries,
    set_binary_publisher,
} from '../../kernel/exec/program_registry.js';
import {ROOT_UID} from '../../kernel/include/types.js';
import {
    fs_device,
    fs_mkdir,
    fs_symlink,
    fs_write,
} from './builder.js';
import {
    create_init_program_image,
    create_nologin_program_image,
} from './system_programs.js';
import {
    manpage_path,
    render_manual_page,
} from '../../usr/programs/manpages.js';

const SYSTEM_HOSTNAME = 'jsnix';
const DEFAULT_ISSUE = [
    '      _ ____  _   _ _       ',
    '     | / ___|| \\ | (_)_  __ ',
    '  _  | \\___ \\|  \\| | \\ \\/ / ',
    ' | |_| |___) | |\\  | |>  <  ',
    '  \\___/|____/|_| \\_|_/_/\\_\\ ',
].join('\n') + '\n';
const DEFAULT_ROOT_PASSWORD = 'root';
const DEFAULT_INTERACTIVE_SHELL = '/bin/bash';
const NOLOGIN_SHELL = '/usr/sbin/nologin';
const USERNAME_RE = /^[a-z_][a-z0-9_-]*[$]?$/i;

function has_own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function configured_accounts(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object')
        return Object.entries(value).map(([username, account]) => ({
            username,
            ...(account ?? {}),
        }));
    throw new TypeError('rootfs accounts must be an array or object');
}

function normalize_rootfs_options(options = {}) {
    const account_source =
        options.users ??
        options.accounts ??
        options.default_users ??
        options.default_accounts ??
        [];
    return {
        include_guest: options.include_guest ?? true,
        hostname: options.hostname ?? SYSTEM_HOSTNAME,
        issue: options.issue ?? DEFAULT_ISSUE,
        root_password: has_own(options, 'root_password')
            ? options.root_password
            : DEFAULT_ROOT_PASSWORD,
        users: configured_accounts(account_source),
    };
}

function clone_user(user) {
    return {
        ...user,
        groups: [...(user.groups ?? [])],
    };
}

function clone_group(group) {
    return {
        ...group,
        members: [...(group.members ?? [])],
    };
}

function unique_ids(ids) {
    const values = Array.isArray(ids) ? ids : [ids];
    return [...new Set(values.map(Number).filter(Number.isInteger))];
}

function validate_id(kind, value) {
    if (!Number.isInteger(value) || value < 0)
        throw new TypeError(`rootfs ${kind} must be a non-negative integer`);
    return value;
}

function next_free_id(entries, field) {
    let id = 1000;
    while (entries.some(entry => entry[field] === id)) id++;
    return id;
}

function password_fields(password, locked = false) {
    if (locked || password === false || password === null)
        return {pw_hash: '!', shadow_hash: '!', locked: true};
    const plain = String(password);
    return {
        pw_hash: plain,
        shadow_hash: make_shadow_hash(plain),
        locked: false,
    };
}

const INITIAL_USERS = [
    {
        username: 'root',
        uid: 0,
        gid: 0,
        groups: [0],
        gecos: 'root',
        home: '/root',
        shell: '/bin/bash',
        pw_hash: 'root',
        shadow_hash: '$6$jsnix$Ua9ruLwRTGqlvNZHbwfSQr573SbjnbO5mH.qZH1VVhOu.WkCZSywx2D9dGlL3VVZTCPxeTMPYTNv2xMCyvZNX0',
    },
    {
        username: 'daemon',
        uid: 1,
        gid: 1,
        groups: [1],
        gecos: 'daemon',
        home: '/usr/sbin',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'bin',
        uid: 2,
        gid: 2,
        groups: [2],
        gecos: 'bin',
        home: '/bin',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'sys',
        uid: 3,
        gid: 3,
        groups: [3],
        gecos: 'sys',
        home: '/dev',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'sync',
        uid: 4,
        gid: 65534,
        groups: [65534],
        gecos: 'sync',
        home: '/bin',
        shell: '/bin/sync',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'games',
        uid: 5,
        gid: 60,
        groups: [60],
        gecos: 'games',
        home: '/usr/games',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'man',
        uid: 6,
        gid: 12,
        groups: [12],
        gecos: 'man',
        home: '/var/cache/man',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'lp',
        uid: 7,
        gid: 7,
        groups: [7],
        gecos: 'lp',
        home: '/var/spool/lpd',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'mail',
        uid: 8,
        gid: 8,
        groups: [8],
        gecos: 'mail',
        home: '/var/mail',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'news',
        uid: 9,
        gid: 9,
        groups: [9],
        gecos: 'news',
        home: '/var/spool/news',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'uucp',
        uid: 10,
        gid: 10,
        groups: [10],
        gecos: 'uucp',
        home: '/var/spool/uucp',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'proxy',
        uid: 13,
        gid: 13,
        groups: [13],
        gecos: 'proxy',
        home: '/bin',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'www-data',
        uid: 33,
        gid: 33,
        groups: [33],
        gecos: 'www-data',
        home: '/var/www',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'backup',
        uid: 34,
        gid: 34,
        groups: [34],
        gecos: 'backup',
        home: '/var/backups',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'list',
        uid: 38,
        gid: 38,
        groups: [38],
        gecos: 'Mailing List Manager',
        home: '/var/list',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'irc',
        uid: 39,
        gid: 39,
        groups: [39],
        gecos: 'ircd',
        home: '/run/ircd',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: '_apt',
        uid: 42,
        gid: 65534,
        groups: [65534],
        gecos: '',
        home: '/nonexistent',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'nobody',
        uid: 65534,
        gid: 65534,
        groups: [65534],
        gecos: 'nobody',
        home: '/nonexistent',
        shell: '/usr/sbin/nologin',
        pw_hash: '!',
        locked: true,
    },
    {
        username: 'guest',
        uid: 1000,
        gid: 1000,
        groups: [1000, 100],
        gecos: 'Guest User',
        home: '/home/guest',
        shell: '/bin/bash',
        pw_hash: 'guest',
        shadow_hash: '$6$jsnix$YD6xSVJxPDUfFu6G1JrXDOsvaQqf81kwWB0PxNynnJfACyOlmTj77J4oWFH99ETMNlL6J/E3YkDvoirL1H7Hw/',
    },
];

const INITIAL_GROUPS = [
    {gid: 0, name: 'root', members: ['root']},
    {gid: 1, name: 'daemon', members: ['daemon']},
    {gid: 2, name: 'bin', members: ['bin']},
    {gid: 3, name: 'sys', members: ['sys']},
    {gid: 4, name: 'adm', members: []},
    {gid: 5, name: 'tty', members: []},
    {gid: 6, name: 'disk', members: []},
    {gid: 7, name: 'lp', members: ['lp']},
    {gid: 8, name: 'mail', members: ['mail']},
    {gid: 9, name: 'news', members: ['news']},
    {gid: 10, name: 'uucp', members: ['uucp']},
    {gid: 12, name: 'man', members: ['man']},
    {gid: 13, name: 'proxy', members: ['proxy']},
    {gid: 15, name: 'kmem', members: []},
    {gid: 20, name: 'dialout', members: []},
    {gid: 21, name: 'fax', members: []},
    {gid: 22, name: 'voice', members: []},
    {gid: 24, name: 'cdrom', members: []},
    {gid: 25, name: 'floppy', members: []},
    {gid: 26, name: 'tape', members: []},
    {gid: 27, name: 'sudo', members: []},
    {gid: 29, name: 'audio', members: []},
    {gid: 30, name: 'dip', members: []},
    {gid: 33, name: 'www-data', members: ['www-data']},
    {gid: 34, name: 'backup', members: ['backup']},
    {gid: 37, name: 'operator', members: []},
    {gid: 38, name: 'list', members: ['list']},
    {gid: 39, name: 'irc', members: ['irc']},
    {gid: 40, name: 'src', members: []},
    {gid: 42, name: 'shadow', members: []},
    {gid: 43, name: 'utmp', members: []},
    {gid: 44, name: 'video', members: []},
    {gid: 45, name: 'sasl', members: []},
    {gid: 46, name: 'plugdev', members: []},
    {gid: 50, name: 'staff', members: []},
    {gid: 60, name: 'games', members: ['games']},
    {gid: 100, name: 'users', members: ['guest']},
    {gid: 1000, name: 'guest', members: ['guest']},
    {gid: 65534, name: 'nogroup', members: ['sync', '_apt', 'nobody']},
];

function normalize_account(account, users) {
    const username = String(account.username ?? account.name ?? '').trim();
    if (!USERNAME_RE.test(username))
        throw new TypeError(`rootfs account has invalid username '${username}'`);

    const current = users.find(user => user.username === username);
    const uid = validate_id(
        'uid',
        account.uid ?? current?.uid ?? next_free_id(users, 'uid'),
    );
    const gid = validate_id(
        'gid',
        account.gid ?? current?.gid ?? uid,
    );
    const explicit_groups = has_own(account, 'groups')
        ? unique_ids(account.groups ?? [])
        : unique_ids((current?.groups ?? []).filter(group_id => group_id !== current?.gid));
    const password = has_own(account, 'password')
        ? account.password
        : has_own(account, 'pw_hash')
            ? account.pw_hash
            : current?.pw_hash ?? username;
    return {
        username,
        uid,
        gid,
        groups: unique_ids([gid, ...explicit_groups]),
        gecos: account.gecos ?? current?.gecos ?? username,
        home: account.home ?? current?.home ?? `/home/${username}`,
        shell: account.shell ?? current?.shell ?? DEFAULT_INTERACTIVE_SHELL,
        ...password_fields(password, account.locked ?? current?.locked ?? false),
    };
}

function apply_account(users, account) {
    const next = normalize_account(account, users);
    const index = users.findIndex(user => user.username === next.username);
    if (index >= 0) users[index] = next;
    else users.push(next);
}

function validate_unique_users(users) {
    const seen_uids = new Map();
    for (const user of users) {
        if (!seen_uids.has(user.uid)) {
            seen_uids.set(user.uid, user.username);
            continue;
        }
        const first = seen_uids.get(user.uid);
        if (first !== user.username)
            throw new TypeError(
                `rootfs uid ${user.uid} is used by '${first}' and '${user.username}'`
            );
    }
}

function initial_users(options = {}) {
    const rootfs_options = normalize_rootfs_options(options);
    const users = INITIAL_USERS
        .filter(user => rootfs_options.include_guest || user.username !== 'guest')
        .map(clone_user);
    for (const user of users) {
        if (!user.locked && user.pw_hash && user.pw_hash !== 'x')
            Object.assign(user, password_fields(user.pw_hash));
    }
    const root = users.find(user => user.username === 'root');
    if (root)
        Object.assign(root, password_fields(rootfs_options.root_password));
    for (const account of rootfs_options.users)
        apply_account(users, account);
    validate_unique_users(users);
    return users;
}

function ensure_group(groups, group) {
    const by_gid = groups.find(candidate => candidate.gid === group.gid);
    if (by_gid) return by_gid;
    if (groups.some(candidate => candidate.name === group.name))
        throw new TypeError(`rootfs group '${group.name}' already exists`);
    const created = {
        gid: group.gid,
        name: group.name,
        members: [],
    };
    groups.push(created);
    return created;
}

function initial_groups(options = {}) {
    const rootfs_options = normalize_rootfs_options(options);
    const users = initial_users(rootfs_options);
    const groups = INITIAL_GROUPS
        .filter(group => rootfs_options.include_guest || group.name !== 'guest')
        .map(clone_group)
        .map(group => ({
            ...group,
            members: rootfs_options.include_guest
                ? group.members
                : group.members.filter(member => member !== 'guest'),
        }));

    for (const user of users) {
        ensure_group(groups, {gid: user.gid, name: user.username});
        for (const gid of user.groups) {
            const group = ensure_group(groups, {gid, name: user.username});
            if (!group.members.includes(user.username))
                group.members.push(user.username);
        }
    }
    return groups;
}

const ROOTFS_DIRECTORIES = [
    ['/dev/pts', 0o755, 0, 0],
    ['/dev/shm', 0o1777, 0, 0],
    ['/etc/apt', 0o755, 0, 0],
    ['/etc/cron.d', 0o755, 0, 0],
    ['/etc/cron.daily', 0o755, 0, 0],
    ['/etc/cron.hourly', 0o755, 0, 0],
    ['/etc/cron.monthly', 0o755, 0, 0],
    ['/etc/cron.weekly', 0o755, 0, 0],
    ['/etc/default', 0o755, 0, 0],
    ['/etc/ld.so.conf.d', 0o755, 0, 0],
    ['/etc/init.d', 0o755, 0, 0],
    ['/etc/inputrc.d', 0o755, 0, 0],
    ['/etc/logrotate.d', 0o755, 0, 0],
    ['/etc/network', 0o755, 0, 0],
    ['/etc/pam.d', 0o755, 0, 0],
    ['/etc/profile.d', 0o755, 0, 0],
    ['/etc/security', 0o755, 0, 0],
    ['/etc/skel', 0o755, 0, 0],
    ['/etc/ssl', 0o755, 0, 0],
    ['/etc/ssl/certs', 0o755, 0, 0],
    ['/etc/ssl/private', 0o710, 0, 0],
    ['/etc/systemd', 0o755, 0, 0],
    ['/home', 0o755, 0, 0],
    ['/run/lock', 0o775, 0, 0],
    ['/run/user', 0o755, 0, 0],
    ['/sys/block/jsda', 0o555, 0, 0],
    ['/sys/class/net/eth0', 0o555, 0, 0],
    ['/sys/class/net/lo', 0o555, 0, 0],
    ['/sys/devices/system/cpu/cpu0', 0o555, 0, 0],
    ['/usr/bin', 0o755, 0, 0],
    ['/usr/games', 0o755, 0, 0],
    ['/usr/include', 0o755, 0, 0],
    ['/usr/lib', 0o755, 0, 0],
    ['/usr/lib/x86_64-linux-gnu', 0o755, 0, 0],
    ['/usr/lib64', 0o755, 0, 0],
    ['/usr/local/bin', 0o755, 0, 0],
    ['/usr/local/etc', 0o755, 0, 0],
    ['/usr/local/games', 0o755, 0, 0],
    ['/usr/local/include', 0o755, 0, 0],
    ['/usr/local/lib', 0o755, 0, 0],
    ['/usr/local/lib/x86_64-linux-gnu', 0o755, 0, 0],
    ['/usr/local/man', 0o755, 0, 0],
    ['/usr/local/sbin', 0o755, 0, 0],
    ['/usr/local/share', 0o755, 0, 0],
    ['/usr/local/src', 0o755, 0, 0],
    ['/usr/sbin', 0o755, 0, 0],
    ['/usr/share/doc', 0o755, 0, 0],
    ['/usr/share/info', 0o755, 0, 0],
    ['/usr/share/locale', 0o755, 0, 0],
    ['/usr/share/man/man1', 0o755, 0, 0],
    ['/usr/share/man/man2', 0o755, 0, 0],
    ['/usr/share/man/man3', 0o755, 0, 0],
    ['/usr/share/man/man4', 0o755, 0, 0],
    ['/usr/share/man/man5', 0o755, 0, 0],
    ['/usr/share/man/man6', 0o755, 0, 0],
    ['/usr/share/man/man7', 0o755, 0, 0],
    ['/usr/share/man/man8', 0o755, 0, 0],
    ['/usr/share/misc', 0o755, 0, 0],
    ['/usr/share/zoneinfo/Etc', 0o755, 0, 0],
    ['/usr/src', 0o755, 0, 0],
    ['/var/backups', 0o755, 0, 0],
    ['/var/cache', 0o755, 0, 0],
    ['/var/cache/apt/archives', 0o755, 0, 0],
    ['/var/cache/man', 0o755, 6, 12],
    ['/var/lib', 0o755, 0, 0],
    ['/var/lib/apt/lists', 0o755, 0, 0],
    ['/var/lib/dpkg/info', 0o755, 0, 0],
    ['/var/lib/misc', 0o755, 0, 0],
    ['/var/local', 0o755, 0, 0],
    ['/var/log', 0o755, 0, 0],
    ['/var/mail', 0o2775, 0, 8],
    ['/var/opt', 0o755, 0, 0],
    ['/var/spool', 0o755, 0, 0],
    ['/var/spool/cron', 0o755, 0, 0],
    ['/var/tmp', 0o1777, 0, 0],
    ['/var/www', 0o755, 0, 0],
];

function should_create_home(user) {
    return (user.username === 'root' || user.home?.startsWith('/home/')) &&
        user.home &&
        user.home !== '/nonexistent' &&
        user.shell !== NOLOGIN_SHELL &&
        user.home.startsWith('/');
}

function subid_content(options = {}) {
    const users = initial_users(options)
        .filter(user => user.uid >= 1000 && !user.locked && should_create_home(user));
    return users
        .map((user, index) => `${user.username}:${100000 + (index * 65536)}:65536`)
        .join('\n') + (users.length ? '\n' : '');
}

function passwd_content(users) {
    return users
        .map(user =>
            `${user.username}:x:${user.uid}:${user.gid}:${user.gecos}:${user.home}:${user.shell}`)
        .join('\n') + '\n';
}

function group_content(groups) {
    return groups
        .map(group =>
            `${group.name}:x:${group.gid}:${group.members.join(',')}`)
        .join('\n') + '\n';
}

function shadow_content(users) {
    return users
        .map(user =>
            `${user.username}:${user.locked ? '!' : user.shadow_hash}:19000:0:99999:7:::`)
        .join('\n') + '\n';
}

function gshadow_content(groups) {
    return groups
        .map(group =>
            `${group.name}:!::${group.members.join(',')}`)
        .join('\n') + '\n';
}

const SKEL_FILES = {
    '.bash_logout': [
        '# ~/.bash_logout: executed by bash when a login shell exits.',
        '',
    ].join('\n'),
    '.bashrc': [
        '# ~/.bashrc: executed by bash for non-login shells.',
        '',
        'case $- in',
        '    *i*) ;;',
        '      *) return;;',
        'esac',
        '',
        'HISTCONTROL=ignoreboth',
        'shopt -s histappend',
        '',
    ].join('\n'),
    '.profile': [
        '# ~/.profile: executed by the command interpreter for login shells.',
        '',
        'if [ -n "$BASH_VERSION" ]; then',
        '    if [ -f "$HOME/.bashrc" ]; then',
        '        . "$HOME/.bashrc"',
        '    fi',
        'fi',
        '',
        'PATH="$HOME/bin:$HOME/.local/bin:$PATH"',
        '',
    ].join('\n'),
};

function init_directories() {
    printk('init: init_directories: creating FHS hierarchy');
    for (const [path, mode, uid, gid] of ROOTFS_DIRECTORIES)
        fs_mkdir(path, mode, uid, gid);
    fs_symlink('/run', '/var/run');
    fs_symlink('/run/lock', '/var/lock');
}

function init_devices() {
    printk('init: init_devices: creating device nodes');
    fs_device('/dev/null', 'null', 0o666, 0, 0);
    fs_device('/dev/zero', 'zero', 0o666, 0, 0);
    fs_device('/dev/full', 'full', 0o666, 0, 0);
    fs_device('/dev/random', 'random', 0o666, 0, 0);
    fs_device('/dev/urandom', 'urandom', 0o666, 0, 0);
    fs_device('/dev/tty', 'tty', 0o666, 0, 5);
    fs_device('/dev/console', 'console', 0o600, 0, 5);
    fs_device('/dev/ptmx', 'ptmx', 0o666, 0, 5);
    fs_device('/dev/pts/0', 'pts0', 0o620, 0, 5);
    fs_symlink('/proc/self/fd', '/dev/fd');
    fs_symlink('/proc/self/fd/0', '/dev/stdin');
    fs_symlink('/proc/self/fd/1', '/dev/stdout');
    fs_symlink('/proc/self/fd/2', '/dev/stderr');
}

function init_sysfiles(options = {}) {
    const rootfs_options = normalize_rootfs_options(options);
    printk('init: init_sysfiles: writing /etc');
    const os_release = [
        'PRETTY_NAME="JSNix 0.1.0"',
        'NAME="JSNix"',
        'VERSION_ID="0.1.0"',
        'VERSION="0.1.0"',
        'ID=jsnix',
        'ID_LIKE=debian',
        'HOME_URL="https://example.invalid/jsnix"',
        'SUPPORT_URL="https://example.invalid/jsnix/support"',
        'BUG_REPORT_URL="https://example.invalid/jsnix/issues"',
        '',
    ].join('\n');
    fs_write('/usr/lib/os-release', os_release);
    fs_symlink('../usr/lib/os-release', '/etc/os-release');
    fs_write('/etc/debian_version', '12.0\n');
    fs_write('/etc/hostname', String(rootfs_options.hostname).trim() + '\n');
    fs_write('/etc/issue', String(rootfs_options.issue));
    fs_write('/etc/motd', '', 0o644, 0, 0);
    fs_write('/etc/hosts', [
        '127.0.0.1\tlocalhost',
        `127.0.1.1\t${String(rootfs_options.hostname).trim()}`,
        '',
        '# The following lines are desirable for IPv6 capable hosts',
        '::1\tlocalhost ip6-localhost ip6-loopback',
        'ff02::1\tip6-allnodes',
        'ff02::2\tip6-allrouters',
        '',
    ].join('\n'));
    fs_write('/etc/resolv.conf', [
        'nameserver 10.0.2.3',
        'options edns0 trust-ad',
        '',
    ].join('\n'));
    fs_write('/etc/host.conf', [
        'multi on',
        '',
    ].join('\n'));
    fs_write('/etc/nsswitch.conf', [
        'passwd:         files',
        'group:          files',
        'shadow:         files',
        'gshadow:        files',
        'hosts:          files dns',
        'networks:       files',
        'protocols:      db files',
        'services:       db files',
        'ethers:         db files',
        'rpc:            db files',
        '',
    ].join('\n'));
    fs_write('/etc/fstab', [
        '# <file system> <mount point> <type> <options> <dump> <pass>',
        'jsfs\t/\tjsfs\trw,relatime\t0\t1',
        'proc\t/proc\tproc\tnosuid,nodev,noexec\t0\t0',
        'sysfs\t/sys\tsysfs\tnosuid,nodev,noexec\t0\t0',
        'tmpfs\t/run\ttmpfs\tnosuid,nodev,mode=755\t0\t0',
        '',
    ].join('\n'));
    fs_symlink('/proc/mounts', '/etc/mtab');
    fs_write('/etc/shells', [
        '# /etc/shells: valid login shells',
        '/bin/sh',
        '/bin/dash',
        '/bin/bash',
        '',
    ].join('\n'));
    fs_symlink('dash', '/usr/bin/sh');
    fs_write('/usr/sbin/nologin', create_nologin_program_image(), 0o755, 0, 0);
    fs_write('/usr/sbin/init', create_init_program_image(), 0o755, 0, 0);
    fs_write('/etc/issue.net', 'JSNix 0.1.0\n');
    fs_write('/etc/motd', [
        'The programs included with JSNix are simulated in JavaScript.',
        '',
    ].join('\n'));
    fs_write('/etc/profile', [
        '# /etc/profile: system-wide .profile file for the Bourne shell.',
        '',
        'if [ "$(id -u)" = "0" ]; then',
        '    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
        'else',
        '    PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"',
        'fi',
        'export PATH',
        '',
        'if [ -d /etc/profile.d ]; then',
        '    for i in /etc/profile.d/*.sh; do',
        '        [ -r "$i" ] && . "$i"',
        '    done',
        '    unset i',
        'fi',
        '',
    ].join('\n'));
    fs_write('/etc/bash.bashrc', [
        '# System-wide .bashrc file for interactive bash shells.',
        '',
        '[ -z "$PS1" ] && return',
        '',
        'case "$TERM" in',
        '    xterm*|rxvt*) PROMPT_COMMAND=;;',
        'esac',
        '',
    ].join('\n'));
    fs_write('/etc/environment', '');
    fs_write('/etc/inputrc', [
        '# /etc/inputrc - global inputrc for libreadline',
        '$include /etc/inputrc.d/*',
        '',
    ].join('\n'));
    fs_write('/etc/timezone', 'Etc/UTC\n');
    fs_write('/usr/share/zoneinfo/Etc/UTC', 'TZif2\0JSNix UTC\n', 0o644);
    fs_symlink('/usr/share/zoneinfo/Etc/UTC', '/etc/localtime');
    fs_write('/etc/machine-id', '4a534c696e7578000000000000000000\n', 0o444);
    fs_write('/etc/ld.so.conf', [
        'include /etc/ld.so.conf.d/*.conf',
        '',
    ].join('\n'));
    fs_write('/etc/ld.so.conf.d/x86_64-linux-gnu.conf', [
        '/usr/local/lib/x86_64-linux-gnu',
        '/lib/x86_64-linux-gnu',
        '/usr/lib/x86_64-linux-gnu',
        '',
    ].join('\n'));
    fs_write('/etc/login.defs', [
        'MAIL_DIR        /var/mail',
        'PASS_MAX_DAYS   99999',
        'PASS_MIN_DAYS   0',
        'PASS_WARN_AGE   7',
        'UID_MIN         1000',
        'UID_MAX         60000',
        'GID_MIN         1000',
        'GID_MAX         60000',
        'UMASK           022',
        'USERGROUPS_ENAB yes',
        '',
    ].join('\n'));
    fs_write('/etc/network/interfaces', [
        'auto lo',
        'iface lo inet loopback',
        '',
        'allow-hotplug eth0',
        'iface eth0 inet static',
        '    address 10.0.2.15/24',
        '    gateway 10.0.2.2',
        '',
    ].join('\n'));
    fs_write('/etc/apt/sources.list', [
        '# Package management is not connected in the JSNix simulation.',
        '',
    ].join('\n'));
    fs_write('/etc/adduser.conf', [
        'DSHELL=/bin/bash',
        'DHOME=/home',
        'GROUPHOMES=no',
        'LETTERHOMES=no',
        'SKEL=/etc/skel',
        'FIRST_SYSTEM_UID=100',
        'LAST_SYSTEM_UID=999',
        'FIRST_UID=1000',
        'LAST_UID=59999',
        '',
    ].join('\n'));
    fs_write('/etc/subuid', subid_content(rootfs_options));
    fs_write('/etc/subgid', subid_content(rootfs_options));
    fs_write('/etc/crontab', [
        'SHELL=/bin/sh',
        'PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin',
        '',
        '# m h dom mon dow user command',
        '',
    ].join('\n'));
    fs_write('/etc/services', [
        'ssh\t22/tcp',
        'domain\t53/tcp',
        'domain\t53/udp',
        'http\t80/tcp\twww',
        'https\t443/tcp',
        '',
    ].join('\n'));
    fs_write('/etc/protocols', [
        'ip\t0\tIP',
        'icmp\t1\tICMP',
        'tcp\t6\tTCP',
        'udp\t17\tUDP',
        '',
    ].join('\n'));
    fs_write('/etc/passwd', '', 0o644, 0, 0);
    fs_write('/etc/group', '', 0o644, 0, 0);
    fs_write('/etc/shadow', '', 0o640, 0, 42);
    fs_write('/etc/gshadow', '', 0o640, 0, 42);
    for (const [name, content] of Object.entries(SKEL_FILES))
        fs_write(`/etc/skel/${name}`, content, 0o644, 0, 0);
    fs_write('/var/log/auth.log', '', 0o640, 0, 4);
    fs_write('/var/log/kern.log', '', 0o640, 0, 4);
    fs_write('/var/log/syslog', '', 0o640, 0, 4);
    fs_write('/var/log/boot.log', '', 0o640, 0, 4);
    fs_write('/var/log/lastlog', '', 0o664, 0, 43);
    fs_write('/var/log/wtmp', '', 0o664, 0, 43);
    fs_write('/var/log/btmp', '', 0o660, 0, 43);
    fs_write('/run/utmp', '', 0o664, 0, 43);
    fs_symlink('/var/mail', '/var/spool/mail');
    fs_write('/var/lib/dpkg/status', [
        'Package: jsnix-base',
        'Status: install ok installed',
        'Architecture: js-x64',
        'Version: 0.1.0',
        'Description: JSNix simulated base system',
        '',
    ].join('\n'));
    fs_write('/var/lib/dpkg/available', '');
    fs_write('/sys/class/net/lo/address', '00:00:00:00:00:00\n', 0o444);
    fs_write('/sys/class/net/lo/operstate', 'unknown\n', 0o444);
    fs_write('/sys/class/net/eth0/address', '02:00:00:00:00:01\n', 0o444);
    fs_write('/sys/class/net/eth0/operstate', 'up\n', 0o444);
    fs_write('/sys/block/jsda/size', '2097152\n', 0o444);
    fs_write('/sys/devices/system/cpu/online', '0\n', 0o444);
    fs_write('/sys/devices/system/cpu/possible', '0\n', 0o444);
    printk('init: init_sysfiles: done');
}

function publish_binary(entry) {
    fs_write(
        entry.path,
        entry.image,
        entry.mode,
        entry.uid,
        entry.gid,
    );
    fs_write(
        manpage_path(entry.name),
        render_manual_page(entry.name, entry.man),
        0o644,
        0,
        0,
    );
}

function init_binaries() {
    set_binary_publisher(publish_binary);
    printk(
        `init: init_binaries: ${list_binary_entries().length} executable files created`
    );
}

function init_users(options = {}) {
    const users = initial_users(options);
    const groups = initial_groups(options);
    printk('init: init_users: writing account files');
    fs_write('/etc/passwd', passwd_content(users), 0o644, 0, 0);
    fs_write('/etc/group', group_content(groups), 0o644, 0, 0);
    fs_write('/etc/shadow', shadow_content(users), 0o640, 0, 42);
    fs_write('/etc/gshadow', gshadow_content(groups), 0o640, 0, 42);
    load_account_files();
    for (const u of users)
        printk(`init: init_users: uid=${u.uid} '${u.username}' home=${u.home}`);
    printk(`init: init_users: ${users.length} accounts registered`);
}

function init_homedirs(options = {}) {
    const users = initial_users(options);
    printk('init: init_homedirs: creating home directories');
    for (const u of users) {
        if (!should_create_home(u)) continue;
        const dir_mode = (u.uid === ROOT_UID) ? 0o700 : 0o755;
        fs_mkdir(u.home, dir_mode, u.uid, u.gid);
        for (const [fname, content] of Object.entries(SKEL_FILES))
            fs_write(`${u.home}/${fname}`, content, 0o644, u.uid, u.gid);
        printk(
            `init: init_homedirs: ${u.home} (${Object.keys(SKEL_FILES).length} files)`
        );
    }
}

export function populate_rootfs(options = {}) {
    const rootfs_options = normalize_rootfs_options(options);
    printk('init: populate_rootfs: start');
    init_directories();
    init_devices();
    init_sysfiles(rootfs_options);
    init_binaries();
    init_users(rootfs_options);
    init_homedirs(rootfs_options);
    printk('init: populate_rootfs: complete');
}

export function do_basic_setup() {
    const n = list_binary_entries().length;
    printk(`init: do_basic_setup: ${n} binaries registered`);
}
