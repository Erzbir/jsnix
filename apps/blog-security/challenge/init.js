'use strict';

import {BLOG_SECURITY_CHALLENGE} from './config.js';

const CHALLENGE = BLOG_SECURITY_CHALLENGE;

function shell_quote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run_checked(profile, command) {
    const result = profile.run_as_root(command);
    if (result.status === 0) return result.output;
    throw new Error(result.text || `command failed: ${command}`);
}

function lookup_account(profile, username) {
    const result = profile.run_as_root(`getent passwd ${shell_quote(username)}`);
    if (result.status !== 0) return null;
    const line = result.output.map(item => item.text ?? '').find(Boolean);
    const fields = line?.split(':') ?? [];
    if (fields.length < 7) return null;
    return {
        name: fields[0],
        username: fields[0],
        uid: Number(fields[2]),
        gid: Number(fields[3]),
        gecos: fields[4],
        home: fields[5],
        shell: fields[6],
    };
}

function write_owned_file(profile, path, content, mode, owner_group) {
    run_checked(
        profile,
        `printf '%s' ${shell_quote(content)} > ${shell_quote(path)}`,
    );
    run_checked(profile, `chown ${owner_group} ${shell_quote(path)}`);
    run_checked(profile, `chmod ${mode.toString(8)} ${shell_quote(path)}`);
}

function challenge_files() {
    const user = CHALLENGE.account.username;
    return [
        [
            CHALLENGE.paths.encrypted_flag,
            CHALLENGE.encrypted_flag,
            0o600,
            `${user}:${user}`,
        ],
        [
            CHALLENGE.paths.user_hint,
            CHALLENGE.user_hint,
            0o600,
            `${user}:${user}`,
        ],
        [
            `${CHALLENGE.account.home}/.bash_history`,
            '',
            0o600,
            `${user}:${user}`,
        ],
        [CHALLENGE.paths.root_hint, CHALLENGE.root_hint, 0o600, 'root:root'],
        [CHALLENGE.paths.sudoers, CHALLENGE.sudoers, 0o644, 'root:root'],
    ];
}

export function initChallenge(profile) {
    try {
        const config = CHALLENGE.account;
        let account = lookup_account(profile, config.username);
        if (!account) {
            run_checked(profile, [
                'useradd',
                '-c', shell_quote('Blog Security Administrator'),
                '-d', shell_quote(config.home),
                '-s', shell_quote(config.shell),
                '-p', shell_quote(config.password),
                shell_quote(config.username),
            ].join(' '));
            account = lookup_account(profile, config.username);
        }
        if (!account)
            throw new Error('Blog Security account creation failed');

        run_checked(profile, `chmod 750 ${shell_quote(config.home)}`);
        for (const file of challenge_files())
            write_owned_file(profile, ...file);
        return account;
    } catch (error) {
        throw new Error(`Blog Security initialization failed: ${error.message}`);
    }
}
