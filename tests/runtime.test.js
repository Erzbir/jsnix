import assert from 'node:assert/strict';
import test from 'node:test';

import '../src/usr/programs/index.js';
import {Bash, bash_tab_complete} from '../src/usr/shell/bash.js';
import {
    create_tty,
    tty_move_history,
    tty_replace_completion,
} from '../src/drivers/tty/index.js';
import {start_kernel} from '../src/init/boot.js';
import {ksyms} from '../src/kernel/ksyms.js';
import {create_kernel_view} from '../src/kernel/public.js';
import {create_kernel} from '../src/runtime/kernel.js';
import {initChallenge} from '../apps/blog-security/challenge/init.js';
import {
    create_program_image,
    JSNIX_EXEC_MAGIC,
    parse_program_image,
} from '../src/kernel/exec/binfmt_js.js';
import {
    register_binary,
} from '../src/kernel/exec/program_registry.js';
import {
    mountTerminal,
    readMountOptions,
} from '../apps/terminal/app.js';

start_kernel();

const root = new Bash(0, 0);

function text(lines) {
    return lines.map(line => line.text ?? '').join('\n');
}

function live_pids(comm) {
    const pids = [];
    ksyms.for_each_task(task => {
        if (task.comm === comm) pids.push(task.pid);
    });
    return pids;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function write_executable(path, program, mode = 0o755) {
    const source = typeof program === 'function'
        ? create_program_image(program)
        : String(program);
    const written = ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        path,
        source,
        false,
    );
    assert.equal(written.err, undefined);
    const changed = ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        path,
        mode,
    );
    assert.equal(changed.err, undefined);
}

test('boots PID 1 and creates a root shell', () => {
    assert.equal(ksyms.get_task(1)?.comm, 'init');
    assert.equal(root.username, 'root');
    assert.equal(root.cwd, '/root');
    assert.equal(text(root.execute('pwd')), '/root');
});

test('exposes only a read-only public kernel view', () => {
    const view = create_kernel_view();
    const init = view.tasks().find(task => task.pid === 1);
    const root_stat = view.stat('/root');

    assert.equal(view.getUser('root').username, 'root');
    assert.equal(init.comm, 'init');
    assert.equal('envp' in init, false);
    assert.equal(root_stat.type, 'dir');
    assert.equal('i_data' in root_stat, false);
    assert.equal('syscall' in view, false);
    assert.equal('kernel_spawn' in view, false);
    assert.equal('bind_exec_resources' in view, false);
    assert.equal('prepare_exec_credentials' in view, false);
});

test('provides an application-facing kernel facade', () => {
    const kernel = create_kernel({name: 'test-kernel'});
    const pid1 = kernel.boot_state.pid1;
    const task_count = kernel.inspect.tasks().length;

    assert.equal(kernel.name, 'test-kernel');
    assert.equal(kernel.isolated, false);
    assert.equal(kernel.booted, true);
    assert.equal(kernel.boot(), kernel);
    assert.equal(kernel.boot_state.pid1, pid1);
    assert.equal(
        kernel.inspect.tasks().filter(task => task.comm === 'init').length,
        1
    );
    assert.equal(kernel.inspect.tasks().length, task_count);

    const tty = kernel.create_tty({login: false, uid: 0});
    tty.start();
    assert.equal(tty.state.user, 'root');
    tty.destroy();
});

test('terminal app mounts the configured container', () => {
    const container = {
        dataset: {
            uid: '0',
            login: 'false',
            guest: 'false',
            height: '420px',
            sidebar: 'false',
            style: 'false',
            rootPassword: 'toor',
            banner: 'Lab\\nTerminal',
        },
    };
    const calls = [];
    const tty = {id: 'tty'};
    const api = {
        create_tty(options) {
            calls.push({kind: 'create_tty', options});
            return tty;
        },
    };
    const renderer = (target, rendered_tty, options) => {
        calls.push({kind: 'render', target, tty: rendered_tty, options});
        return {target, tty: rendered_tty, options};
    };

    assert.deepEqual(readMountOptions(container), {
        uid: 0,
        login: false,
        include_guest: false,
        height: '420px',
        sidebar: false,
        style: false,
        root_password: 'toor',
        banner: 'Lab\nTerminal',
    });
    assert.equal(mountTerminal(container, api, console, renderer).target, container);
    assert.deepEqual(calls, [
        {
            kind: 'create_tty',
            options: {
                uid: 0,
                login: false,
                include_guest: false,
                height: '420px',
                sidebar: false,
                style: false,
                root_password: 'toor',
                banner: 'Lab\nTerminal',
            },
        },
        {
            kind: 'render',
            target: container,
            tty,
            options: {
                uid: 0,
                login: false,
                include_guest: false,
                height: '420px',
                sidebar: false,
                style: false,
                root_password: 'toor',
                banner: 'Lab\nTerminal',
            },
        },
    ]);
});

test('TTY boot banner can be disabled or customized', () => {
    const quiet = create_tty({login: false, uid: 0, banner: false});
    const quiet_lines = [];
    quiet.on('output', line => quiet_lines.push(line.text ?? ''));
    quiet.start();

    assert.equal(
        quiet_lines.some(line => line.includes('| / ___|')),
        false,
    );
    quiet.destroy();

    const custom = create_tty({
        login: false,
        uid: 0,
        banner: ['Custom Lab', {text: 'Ready', tone: 'success'}],
    });
    const custom_lines = [];
    custom.on('output', line => custom_lines.push(line));
    custom.start();

    assert.equal(custom_lines[0].text, 'Custom Lab');
    assert.equal(custom_lines[0].tone, 'banner');
    assert.equal(custom_lines[1].text, 'Ready');
    assert.equal(custom_lines[1].tone, 'success');
    custom.destroy();
});

test('creates files through output redirection and appends data', () => {
    assert.deepEqual(root.execute('echo hello > /tmp/output.txt'), []);
    assert.deepEqual(root.execute('echo world >> /tmp/output.txt'), []);
    assert.equal(
        text(root.execute('cat /tmp/output.txt')),
        'hello\nworld'
    );
});

test('parses quoted operators, variables, pipelines and input redirection', () => {
    root.execute("echo 'a | b' > /tmp/quoted.txt");
    assert.equal(text(root.execute('cat /tmp/quoted.txt')), 'a | b');

    root.execute("echo '$HOME' > /tmp/literal.txt");
    assert.equal(text(root.execute('cat /tmp/literal.txt')), '$HOME');

    root.execute('echo "$HOME" > /tmp/expanded.txt');
    assert.equal(text(root.execute('cat /tmp/expanded.txt')), '/root');

    assert.match(text(root.execute('cat /tmp/output.txt | grep world')), /world/);
    assert.match(text(root.execute('grep hello < /tmp/output.txt')), /hello/);
});

test('enforces search permission on parent directories', () => {
    const guest_account = ksyms.getpwnam('guest');
    const guest = new Bash(guest_account.uid, guest_account.gid);
    const output = guest.execute('cat /root/welcome.txt');

    assert.equal(guest.username, 'guest');
    assert.equal(guest.cwd, '/home/guest');
    assert.match(text(output), /Permission denied/);
    assert.equal(guest.last_exit_status, 1);
});

test('does not expose password hashes through exported credentials', () => {
    const root_entry = ksyms.getpwnam('root');

    assert.equal(root_entry.username, 'root');
    assert.equal(root_entry.uid, 0);
    assert.equal('pw_hash' in root_entry, false);
});

test('useradd creates a home directory owned by the new user', () => {
    assert.equal(root.execute('useradd alice')[0].text, "useradd: user 'alice' created");

    const alice = ksyms.getpwnam('alice');
    const home = ksyms.path_lookup('/home/alice');

    assert.ok(alice.uid > ksyms.getpwnam('guest').uid);
    assert.equal(home.i_uid, alice.uid);
    assert.equal(home.i_gid, alice.gid);
});

test('manages groups and grants access through supplementary membership', () => {
    assert.match(text(root.execute('groupadd -g 3000 developers')), /created/);
    assert.match(
        text(root.execute('useradd -G developers -p bobpw bob')),
        /created/
    );

    const bob = ksyms.getpwnam('bob');
    assert.deepEqual(bob.groups, [bob.gid, 3000]);
    assert.match(text(root.execute('id bob')), /3000\(developers\)/);

    root.execute('mkdir /srv/shared');
    root.execute('chgrp developers /srv/shared');
    root.execute('chmod 2770 /srv/shared');

    const bob_shell = new Bash(bob.uid, bob.gid);
    assert.deepEqual(bob_shell.execute('echo team > /srv/shared/note.txt'), []);

    const note = ksyms.path_lookup('/srv/shared/note.txt');
    assert.equal(note.i_uid, bob.uid);
    assert.equal(note.i_gid, 3000);
});

test('applies umask and symbolic chmod modes', () => {
    const bob = ksyms.getpwnam('bob');
    const shell = new Bash(bob.uid, bob.gid);

    assert.deepEqual(shell.execute('umask 077'), []);
    assert.deepEqual(shell.execute('touch private.txt'), []);
    assert.equal(
        ksyms.path_lookup('/home/bob/private.txt').i_mode & 0o777,
        0o600
    );

    assert.deepEqual(shell.execute('chmod g+r private.txt'), []);
    assert.equal(
        ksyms.path_lookup('/home/bob/private.txt').i_mode & 0o777,
        0o640
    );
});

test('enforces sticky directory ownership rules', () => {
    const bob = ksyms.getpwnam('bob');
    const alice = ksyms.getpwnam('alice');
    const bob_shell = new Bash(bob.uid, bob.gid);
    const alice_shell = new Bash(alice.uid, alice.gid);

    bob_shell.execute('echo owned > /tmp/bob-file');
    const denied = alice_shell.execute('rm /tmp/bob-file');

    assert.match(text(denied), /Operation not permitted/);
    assert.ok(ksyms.path_lookup('/tmp/bob-file'));
    assert.deepEqual(bob_shell.execute('rm /tmp/bob-file'), []);
});

test('supports usermod and group membership changes', () => {
    assert.match(
        text(root.execute('groupadd operations')),
        /created/
    );
    assert.match(
        text(root.execute('usermod -aG operations alice')),
        /updated/
    );

    const operations = ksyms.getgrnam('operations');
    assert.ok(ksyms.getpwnam('alice').groups.includes(operations.gid));
    assert.match(text(root.execute('groups alice')), /operations/);

    assert.match(
        text(root.execute('gpasswd -d alice operations')),
        /Removing/
    );
    assert.equal(
        ksyms.getpwnam('alice').groups.includes(operations.gid),
        false
    );
});

test('rejects privileged account management from an unprivileged shell', () => {
    const alice = ksyms.getpwnam('alice');
    const shell = new Bash(alice.uid, alice.gid);
    const output = shell.execute('useradd intruder');

    assert.match(text(output), /Permission denied/);
    assert.equal(ksyms.getpwnam('intruder'), null);
});

test('keeps shell credential and environment changes behind system calls', () => {
    const shell = new Bash(0, 0);

    assert.deepEqual(shell.execute('export SAMPLE=value'), []);
    assert.equal(text(shell.execute('printenv SAMPLE')), 'value');

    assert.equal(
        text(shell.execute('SAMPLE=temporary printenv SAMPLE')),
        'temporary'
    );
    assert.equal(text(shell.execute('printenv SAMPLE')), 'value');

    assert.deepEqual(shell.execute('unset SAMPLE'), []);
    assert.equal(text(shell.execute('printenv SAMPLE')), '');

    assert.equal(text(shell.execute('type su')), 'su is /usr/bin/su');
    assert.deepEqual(shell.execute('su guest'), []);
    assert.equal(shell.username, 'guest');
    assert.equal(shell.cwd, '/root');
    assert.deepEqual(shell.execute('exit'), []);
    assert.equal(shell.username, 'root');
});

test('provides su as a real executable without passwordless setuid bypass', () => {
    const su = ksyms.path_lookup('/usr/bin/su');
    const guest_account = ksyms.getpwnam('guest');
    const guest_shell = new Bash(guest_account.uid, guest_account.gid);
    const root_shell = new Bash(0, 0);

    assert.equal(su.i_type, 'file');
    assert.equal(su.i_uid, 0);
    assert.equal(su.i_gid, 0);
    assert.equal(su.i_mode & 0o7777, 0o4755);
    assert.equal(text(guest_shell.execute('which su')), '/usr/bin/su');

    assert.match(
        text(guest_shell.execute('/usr/bin/su root')),
        /Authentication failure/
    );
    assert.equal(guest_shell.username, 'guest');

    assert.deepEqual(root_shell.execute('/usr/bin/su guest'), []);
    assert.equal(root_shell.username, 'guest');
    assert.equal(root_shell.cwd, '/root');
    assert.deepEqual(root_shell.execute('exit'), []);
    assert.equal(root_shell.username, 'root');
});

test('keeps the generic boot free of app challenge accounts, files and policy', () => {
    assert.equal(ksyms.getpwnam('admin'), null);
    assert.equal(ksyms.path_lookup('/home/admin'), null);
    assert.equal(ksyms.path_lookup('/home/admin/flag.txt'), null);
    assert.equal(ksyms.path_lookup('/root/flag.txt'), null);
    assert.equal(ksyms.path_lookup('/etc/sudoers'), null);

    const sudo = ksyms.path_lookup('/usr/bin/sudo');
    assert.equal(sudo.i_type, 'file');
    assert.equal(sudo.i_uid, 0);
    assert.equal(sudo.i_gid, 0);
    assert.equal(sudo.i_mode & 0o7777, 0o4755);
});

test('default TTY login rejects the app challenge admin before initialization', () => {
    const tty = create_tty({login: true});
    const outputs = [];
    tty.on('output', output => outputs.push(output));

    tty.start();
    tty.submit('admin');
    tty.submit('admin');

    assert.ok(outputs.some(output => output.text === 'Login incorrect'));
    assert.equal(tty.state.user, null);
    assert.equal(ksyms.getpwnam('admin'), null);
    tty.destroy();
});

test('initializes the Blog Security challenge through ordinary commands', () => {
    const initialized = create_kernel().apply_profile(initChallenge);
    const admin = ksyms.getpwnam('admin');
    const encrypted = ksyms.path_lookup('/home/admin/flag.txt');
    const notes = ksyms.path_lookup('/home/admin/notes.txt');
    const root_hint = ksyms.path_lookup('/root/flag.txt');
    const sudoers = ksyms.path_lookup('/etc/sudoers');

    assert.equal(initialized.name, 'admin');
    assert.ok(admin.uid > ksyms.getpwnam('guest').uid);
    assert.equal(admin.home, '/home/admin');
    assert.equal(encrypted.i_uid, admin.uid);
    assert.equal(encrypted.i_mode & 0o777, 0o600);
    assert.equal(notes.i_uid, admin.uid);
    assert.equal(notes.i_mode & 0o777, 0o600);
    assert.equal(root_hint.i_uid, 0);
    assert.equal(root_hint.i_mode & 0o777, 0o600);
    assert.equal(sudoers.i_mode & 0o777, 0o644);
    assert.match(sudoers.i_data, /root ALL=\(ALL:ALL\) ALL/);
    assert.match(sudoers.i_data, /admin ALL=\(ALL\) NOPASSWD: \/bin\/bash/);
    assert.match(
        ksyms.path_lookup('/var/log/auth.log').i_data,
        /useradd: new user 'admin'/
    );
});

test('supports the complete Blog Security privilege-escalation path', () => {
    const admin_account = ksyms.getpwnam('admin');
    const shell = new Bash(admin_account.uid, admin_account.gid);

    assert.equal(shell.username, 'admin');
    assert.equal(shell.cwd, '/home/admin');
    assert.match(text(shell.execute('cat flag.txt')), /^[0-9a-f]+$/);
    assert.equal(
        text(shell.execute('cat notes.txt')),
        'I am going to fix some insecure configurations'
    );
    assert.match(
        text(shell.execute('cat /root/flag.txt')),
        /Permission denied/
    );
    assert.match(
        text(shell.execute('cat /etc/sudoers')),
        /NOPASSWD: \/bin\/bash/
    );

    assert.deepEqual(shell.execute('sudo bash'), []);
    assert.equal(shell.username, 'root');
    assert.equal(shell.cwd, '/home/admin');
    assert.equal(
        text(shell.execute('cat /root/flag.txt')),
        'flag is encrypted by xor(0x81)'
    );
    assert.deepEqual(shell.execute('sudo bash'), []);
    assert.equal(shell.username, 'root');
    assert.deepEqual(shell.execute('exit'), []);
    assert.equal(shell.username, 'root');
    assert.deepEqual(shell.execute('exit'), []);
    assert.equal(shell.username, 'admin');
    assert.equal(shell.cwd, '/home/admin');
});

test('rejects sudo escalation when no sudoers rule matches', () => {
    const guest_account = ksyms.getpwnam('guest');
    const shell = new Bash(guest_account.uid, guest_account.gid);
    const output = shell.execute('sudo bash');

    assert.match(text(output), /not allowed to execute/);
    assert.equal(shell.username, 'guest');
    assert.equal(shell.last_exit_status, 1);
});

test('rejects a sudoers file writable by group or other users', () => {
    const admin_account = ksyms.getpwnam('admin');
    const shell = new Bash(admin_account.uid, admin_account.gid);

    root.execute('chmod 0666 /etc/sudoers');
    assert.match(
        text(shell.execute('sudo bash')),
        /not allowed to execute/
    );
    assert.equal(shell.username, 'admin');
    root.execute('chmod 0644 /etc/sudoers');
});

test('requires the sudo executable file and execute permission', () => {
    const admin_account = ksyms.getpwnam('admin');
    const shell = new Bash(admin_account.uid, admin_account.gid);

    root.execute('chmod 0644 /usr/bin/sudo');
    assert.match(text(shell.execute('sudo bash')), /Permission denied/);
    assert.equal(shell.username, 'admin');

    root.execute('chmod 0755 /usr/bin/sudo');
    assert.match(
        text(shell.execute('sudo bash')),
        /effective uid is not 0/
    );
    assert.equal(shell.username, 'admin');

    root.execute('chmod 4755 /usr/bin/sudo');
    assert.deepEqual(shell.execute('sudo bash'), []);
    assert.equal(shell.username, 'root');
    shell.execute('exit');
});

test('does not allow arbitrary JavaScript programs to mint sudo access', () => {
    const admin_account = ksyms.getpwnam('admin');
    const shell = new Bash(admin_account.uid, admin_account.gid);
    write_executable('/home/admin/fake-sudo', [
        '#!/usr/bin/env jsnix-js',
        'ctx.setuid(0);',
        'ctx.special("shell-session");',
        '',
    ].join('\n'));
    root.execute(
        `chown ${admin_account.uid}:${admin_account.gid} ` +
        '/home/admin/fake-sudo'
    );

    const output = shell.execute('./fake-sudo');

    assert.match(text(output), /Operation not permitted/);
    assert.equal(shell.username, 'admin');
    assert.equal(shell.last_exit_status, 1);
});

test('applies setuid credentials during exec without changing the caller', () => {
    register_binary(
        'credential-probe',
        ctx => {
            ctx.printf([
                ctx.getuid(),
                ctx.geteuid(),
                ctx.getgid(),
                ctx.getegid(),
            ].join(':'));
            return 0;
        },
        '/usr/local/bin/credential-probe',
        {mode: 0o4755, uid: 0, gid: 0},
    );
    const guest_account = ksyms.getpwnam('guest');
    const shell = new Bash(guest_account.uid, guest_account.gid);

    assert.equal(
        text(shell.execute('credential-probe')),
        `${guest_account.uid}:0:${guest_account.gid}:${guest_account.gid}`
    );
    assert.equal(shell.uid, guest_account.uid);
});

test('exec permission checks use effective credentials', () => {
    write_executable('/root/effective-only', ctx => {
        ctx.printf(`${ctx.getuid()}:${ctx.geteuid()}`);
    }, 0o700);
    write_executable('/tmp/setuid-runner', ctx => {
        const result = ctx.run(['/root/effective-only']);
        ctx.stdout_buf.push(...result.stdout_buf);
        ctx.stderr_buf.push(...result.stderr_buf);
        return result.exit_code;
    }, 0o4755);

    const guest_account = ksyms.getpwnam('guest');
    const shell = new Bash(guest_account.uid, guest_account.gid);
    assert.equal(
        text(shell.execute('/tmp/setuid-runner')),
        `${guest_account.uid}:0`,
    );
});

test('supports command lists and common text utilities', () => {
    assert.equal(
        text(root.execute('false && echo no || echo yes; echo done')),
        'yes\ndone'
    );
    assert.equal(
        text(root.execute("printf '3\\n1\\n2\\n' | sort -n | tail -n 1")),
        '3'
    );
    assert.equal(
        text(root.execute("echo 'a:b:c' | cut -d: -f2")),
        'b'
    );
    assert.equal(
        text(root.execute('echo lower | tr a-z A-Z')),
        'LOWER'
    );
});

test('supports symbolic links and hard links', () => {
    root.execute('echo linked > /tmp/link-source');
    assert.deepEqual(
        root.execute('ln -s /tmp/link-source /tmp/link-symbolic'),
        []
    );
    assert.equal(
        text(root.execute('readlink /tmp/link-symbolic')),
        '/tmp/link-source'
    );
    assert.equal(
        text(root.execute('realpath /tmp/link-symbolic')),
        '/tmp/link-source'
    );
    assert.equal(text(root.execute('cat /tmp/link-symbolic')), 'linked');

    assert.deepEqual(
        root.execute('ln /tmp/link-source /tmp/link-hard'),
        []
    );
    assert.equal(ksyms.path_lookup('/tmp/link-source').i_nlink, 2);
    root.execute('rm /tmp/link-source');
    assert.equal(text(root.execute('cat /tmp/link-hard')), 'linked');
});

test('supports aliases, globbing, here strings and stderr redirection', () => {
    root.execute('echo first > /tmp/first.glob');
    root.execute('echo second > /tmp/second.glob');
    assert.equal(
        text(root.execute('cat /tmp/*.glob')),
        'first\nsecond'
    );

    assert.deepEqual(root.execute("alias ll='ls -l'"), []);
    assert.match(text(root.execute('ll /tmp/link-symbolic')), /link-symbolic/);

    assert.equal(text(root.execute('base64 <<< hello')), 'aGVsbG8K');
    assert.deepEqual(root.execute('cat /missing 2>/tmp/stderr.log'), []);
    assert.match(text(root.execute('cat /tmp/stderr.log')), /No such file/);
});

test('supports sed, awk, xargs and file comparison tools', () => {
    assert.equal(
        text(root.execute("printf 'a:1\\nb:2\\n' | awk -F: '{print $2}'")),
        '1\n2'
    );
    assert.equal(
        text(root.execute("printf 'a\\nb\\n' | sed 's/a/A/'")),
        'A\nb'
    );
    assert.equal(
        text(root.execute("printf 'one two three' | xargs -n 2 echo")),
        'one two\nthree'
    );
    root.execute('echo old > /tmp/diff-a');
    root.execute('echo new > /tmp/diff-b');
    assert.equal(root.execute('diff /tmp/diff-a /tmp/diff-b').length, 4);
});

test('supports xxd-style hex dumps', () => {
    assert.match(
        text(root.execute("printf 'hello\\n' | xxd")),
        /^00000000: 6865 6c6c 6f0a\s+hello\.$/
    );
    assert.equal(text(root.execute("printf 'ABC' | xxd -p")), '4142430a');

    root.execute("printf 'abcdef' > /tmp/xxd.txt");
    assert.equal(
        text(root.execute('xxd -s 1 -l 4 -c 4 -g 1 /tmp/xxd.txt')),
        '00000001: 62 63 64 65  bcde'
    );

    assert.match(
        text(root.execute('xxd -l 16 /usr/bin/cat')),
        /^00000000: 7f45 4c46 4a53 4e49 5801 0101 00[0-9a-f]{2} [0-9a-f]{4}/
    );
    assert.match(text(root.execute('man xxd')), /make a hex dump/);
});

test('provides deterministic system and virtual network programs', () => {
    assert.match(text(root.execute('lscpu')), /JavaScript Virtual CPU/);
    assert.match(text(root.execute('ip addr')), /10\.0\.2\.15/);
    assert.match(text(root.execute('ping -c 2 localhost')), /0% packet loss/);
    assert.equal(
        text(root.execute('curl http://localhost')),
        'JSNix virtual HTTP service'
    );
    assert.match(root.execute('cat /usr/share/man/man1/ln.1')[0].text, /LN\(1\)/);
    assert.match(text(root.execute('man ln')), /link creation/);
    assert.match(text(root.execute('apropos link')), /ln \(1\)/);
});

test('installs reboot and shutdown as privileged system commands', () => {
    const guest_account = ksyms.getpwnam('guest');
    const guest = new Bash(guest_account.uid, guest_account.gid);

    assert.equal(text(root.execute('which reboot')), '/usr/sbin/reboot');
    assert.equal(text(root.execute('which shutdown')), '/usr/sbin/shutdown');
    assert.match(
        text(guest.execute('shutdown now')),
        /Operation not permitted/,
    );
    assert.equal(ksyms.power_state().state, 'running');
});

test('keeps help as a shell builtin instead of an external program', () => {
    assert.equal(ksyms.path_lookup('/usr/bin/help'), null);
    assert.match(text(root.execute('help cd')), /cd \[dir\]/);
    assert.match(text(root.execute('type help')), /help is a shell builtin/);
    assert.match(text(root.execute('which help')), /help not found/);
    assert.equal(root.last_exit_status, 1);
    assert.match(text(root.execute('man help')), /No manual entry for help/);
});

test('uses a browser HTTP backend for external network programs', () => {
    const previous = globalThis.XMLHttpRequest;
    const requests = [];
    class FakeXMLHttpRequest {
        open(method, url, async) {
            assert.equal(async, false);
            this.method = method;
            this.url = url;
            requests.push({method, url});
        }

        setRequestHeader() {}

        send() {
            this.status = 200;
            this.statusText = 'OK';
            this.responseText = `network:${this.method}:${this.url}`;
        }

        getAllResponseHeaders() {
            return 'content-type: text/plain\r\n';
        }
    }

    globalThis.XMLHttpRequest = FakeXMLHttpRequest;
    try {
        assert.equal(
            text(root.execute('curl https://remote.test/data')),
            'network:GET:https://remote.test/data'
        );
        assert.deepEqual(requests.at(-1), {
            method: 'GET',
            url: 'https://remote.test/data',
        });
        assert.match(
            text(root.execute('ping -c 1 remote.test')),
            /1 packets transmitted, 1 received, 0% packet loss/
        );
        assert.match(
            text(root.execute('wget -O /tmp/remote.txt https://remote.test/file')),
            /bytes written/
        );
        assert.equal(
            text(root.execute('cat /tmp/remote.txt')),
            'network:GET:https://remote.test/file'
        );
    } finally {
        if (previous === undefined) delete globalThis.XMLHttpRequest;
        else globalThis.XMLHttpRequest = previous;
    }
});

test('publishes registered program images in the virtual file system', () => {
    const bin = ksyms.path_lstat('/bin');
    const executable = ksyms.path_lookup('/bin/ls');

    assert.equal(bin.i_type, 'link');
    assert.equal(bin.i_data, '/usr/bin');
    assert.equal(executable.i_type, 'file');
    assert.equal(executable.i_mode & 0o777, 0o755);
    assert.ok(executable.i_data.startsWith(JSNIX_EXEC_MAGIC));
    assert.match(executable.i_data, /parse_flags/);
    assert.equal(executable.i_data.charCodeAt(JSNIX_EXEC_MAGIC.length), 1);
    assert.equal(executable.i_data.charCodeAt(JSNIX_EXEC_MAGIC.length + 1), 1);
    assert.equal(executable.i_data.charCodeAt(JSNIX_EXEC_MAGIC.length + 2), 1);
    assert.equal(executable.i_data.charCodeAt(JSNIX_EXEC_MAGIC.length + 3), 0);
    const image = parse_program_image(executable.i_data);
    assert.equal(image.source.includes('\n'), false);
    assert.deepEqual(image.header, {
        format: 'jsnix-exec',
        abi: 'jsnix-js',
        version: 1,
        kind: 'entry',
    });
    assert.equal(text(root.execute('which ls')), '/usr/bin/ls');
    assert.match(
        text(root.execute('ls /bin')),
        /\bls\b/
    );

    register_binary(
        'probe-command',
        () => 0,
        '/usr/local/bin/probe-command',
        {
            man: {
                description: 'probe command manual',
                synopsis: 'probe-command',
                body: 'This page was installed from register_binary metadata.',
            },
        },
    );
    const probe = ksyms.path_lookup('/usr/local/bin/probe-command');
    assert.equal(probe.i_mode & 0o777, 0o755);
    assert.match(
        text(root.execute('man probe-command')),
        /probe command manual/,
    );
});

test('preserves semantic file types in ls output', () => {
    root.execute('mkdir /tmp/highlight');
    root.execute('mkdir /tmp/highlight/directory');
    root.execute('touch /tmp/highlight/file');
    root.execute('ln -s /tmp/highlight/file /tmp/highlight/link');
    write_executable('/tmp/highlight/executable', ctx => {
        ctx.printf('ok');
        return 0;
    });

    const output = root.execute('ls /tmp/highlight');
    const segments = output.flatMap(line => line.segments ?? []);
    const roles = Object.fromEntries(
        segments
            .filter(segment => segment.role !== 'normal')
            .map(segment => [segment.text.split(' -> ')[0], segment.role])
    );

    assert.equal(roles.directory, 'directory');
    assert.equal(roles.file, 'file');
    assert.equal(roles.link, 'symlink');
    assert.equal(roles.executable, 'executable');

    const long_output = root.execute('ls -l /tmp/highlight/link');
    assert.equal(
        long_output.flatMap(line => line.segments ?? []).at(-1)?.role,
        'symlink'
    );
});

test('loads standalone JavaScript programs from executable files', () => {
    write_executable('/usr/local/bin/process-image', ctx => {
        const self = ctx.list_procs().find(task => task.pid === ctx.getpid());
        ctx.printf([
            self.executable,
            self.argv.join(','),
            Object.keys(self.fdt).join(','),
            self.mm.format,
        ].join('|'));
        return 7;
    });

    const output = root.execute('process-image one two');

    assert.equal(
        text(output),
        '/usr/local/bin/process-image|' +
        '/usr/local/bin/process-image,one,two|0,1,2|jsnix-exec'
    );
    assert.equal(root.last_exit_status, 7);
});

test('does not expose mutable file descriptor table entries to JavaScript programs', () => {
    write_executable('/usr/local/bin/fdt-snapshot', ctx => {
        const self = ctx.list_procs().find(task => task.pid === ctx.getpid());
        self.fdt[1].writable = false;
        ctx.writefd(1, 'stdout still works\n');
        return 0;
    });

    assert.equal(text(root.execute('fdt-snapshot')), 'stdout still works');
});

test('executes manually written JavaScript files with a JSNix shebang', () => {
    const source = [
        '#!/usr/bin/env jsnix-js',
        'ctx => {',
        '    ctx.printf(`manual:${ctx.args.join(":")}`);',
        '    return 4;',
        '}',
        '',
    ].join('\n');
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/manual-js',
        source,
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/manual-js',
        0o755,
    );

    assert.equal(text(root.execute('manual-js one two')), 'manual:one:two');
    assert.equal(root.last_exit_status, 4);
});

test('executes plain JavaScript script bodies with a JSNix shebang', () => {
    const source = [
        '#!/usr/bin/env jsnix-js',
        'ctx.printf(`script:${ctx.args.join(":")}`);',
        'return 5;',
        '',
    ].join('\n');
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/plain-script',
        source,
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/plain-script',
        0o755,
    );

    const output = root.execute('plain-script one two');

    assert.equal(text(output), 'script:one:two');
    assert.doesNotMatch(text(output), /Exec format error/);
    assert.equal(root.last_exit_status, 5);
});

test('jsnix-js shebang executes native JavaScript names directly', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/js-shebang-alert',
        '#!/usr/bin/env jsnix-js\nalert("hello from shebang js")\n',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/js-shebang-alert',
        0o755,
    );

    assert.equal(text(root.execute('js-shebang-alert')), 'hello from shebang js');
    assert.equal(root.last_exit_status, 0);
});

test('runs shebang shell scripts through the registered shell program', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/bash-script',
        '#!/bin/bash\necho bash:$1\nexit 6\n',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/bash-script',
        0o755,
    );

    assert.equal(text(root.execute('bash /usr/local/bin/bash-script one')), 'bash:one');
    assert.equal(root.last_exit_status, 6);
    assert.equal(text(root.execute('/usr/local/bin/bash-script two')), 'bash:two');
    assert.equal(root.last_exit_status, 6);
    assert.doesNotMatch(
        text(root.execute('bash /usr/local/bin/bash-script three')),
        /run_shell_lines is not defined/,
    );
    assert.match(
        text(root.execute('file /usr/local/bin/bash-script')),
        /Bourne-Again shell script, ASCII text executable/,
    );
});

test('non-interactive shell script execution does not leave bash processes alive', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/no-leak-script',
        '#!/bin/bash\necho no-leak\n',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/no-leak-script',
        0o755,
    );
    const before = new Set(live_pids('bash'));

    assert.equal(text(root.execute('/usr/local/bin/no-leak-script')), 'no-leak');

    const leaked = live_pids('bash').filter(pid => !before.has(pid));
    assert.deepEqual(leaked, []);
});

test('does not treat plain shell fallback scripts as JavaScript', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/native-js-script',
        'alert("hello from js")\n',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/native-js-script',
        0o755,
    );

    assert.match(
        text(root.execute('/usr/local/bin/native-js-script')),
        /command not found/,
    );
    assert.equal(root.last_exit_status, 127);
});

test('interprets basic POSIX-style shell script blocks', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/block-script',
        [
            '#!/bin/sh',
            'name=jsnix',
            'if true; then',
            'echo yes:$name',
            'else',
            'echo no',
            'fi',
            'for item in one two; do',
            'echo item:$item',
            'done',
            'exit 3',
            '',
        ].join('\n'),
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/block-script',
        0o755,
    );

    assert.equal(
        text(root.execute('/usr/local/bin/block-script')),
        'yes:jsnix\nitem:one\nitem:two',
    );
    assert.equal(root.last_exit_status, 3);
});

test('interprets inline POSIX-style shell script blocks', () => {
    write_executable(
        '/usr/local/bin/inline-block-script',
        [
            '#!/bin/sh',
            'name=jsnix',
            'if true; then echo inline:$name; else echo no; fi',
            'for item in one two; do echo item:$item; done',
            'while false; do echo never; done',
            '',
        ].join('\n'),
    );

    assert.equal(
        text(root.execute('/usr/local/bin/inline-block-script')),
        'inline:jsnix\nitem:one\nitem:two',
    );
    assert.equal(root.last_exit_status, 0);
});

test('reports EOF for inline loop bodies missing a done separator', () => {
    write_executable(
        '/usr/local/bin/bad-inline-while',
        '#!/bin/sh\nwhile true; do echo 1  done\n',
    );

    const output = text(root.execute('/usr/local/bin/bad-inline-while'));

    assert.match(output, /unexpected end of file/);
    assert.doesNotMatch(output, /expected do/);
    assert.equal(root.last_exit_status, 2);
});

test('keeps shell builtins in the shell process unless a child is required', () => {
    write_executable('/usr/local/bin/showpid', ctx => {
        ctx.printf(String(ctx.getpid()));
        return 0;
    });

    const before_builtins = Number(text(root.execute('showpid')));
    assert.deepEqual(root.execute('true; echo ok > /tmp/builtin-pid; pwd > /tmp/builtin-pwd'), []);
    const after_builtins = Number(text(root.execute('showpid')));

    assert.equal(after_builtins - before_builtins, 1);
    assert.equal(text(root.execute('cat /tmp/builtin-pid')), 'ok');

    const before_external = Number(text(root.execute('showpid')));
    assert.deepEqual(root.execute('/usr/bin/true; /usr/bin/echo ok > /tmp/external-pid'), []);
    const after_external = Number(text(root.execute('showpid')));

    assert.equal(after_external - before_external, 3);
});

test('classifies GNU Bash builtins and reserved words like Linux bash', () => {
    assert.equal(text(root.execute('type if')), 'if is a shell keyword');
    assert.equal(text(root.execute('type time')), 'time is a shell keyword');
    assert.equal(text(root.execute('type test')), 'test is a shell builtin');
    assert.equal(text(root.execute('type [')), '[ is a shell builtin');
    assert.equal(text(root.execute('type type')), 'type is a shell builtin');
    assert.equal(text(root.execute('type kill')), 'kill is a shell builtin');
    assert.equal(text(root.execute('type su')), 'su is /usr/bin/su');
    assert.match(text(root.execute('type which')), /which is \/usr\/bin\/which/);
    assert.match(text(root.execute('type printenv')), /printenv is \/usr\/bin\/printenv/);
    assert.match(text(root.execute('type nice')), /not found/);
    assert.match(text(root.execute('type nohup')), /not found/);
});

test('runs condition and lookup builtins without external command forks', () => {
    write_executable('/usr/local/bin/showpid', ctx => {
        ctx.printf(String(ctx.getpid()));
        return 0;
    });

    const before = Number(text(root.execute('showpid')));
    assert.deepEqual(root.execute('test -d /tmp; [ -n value ]; type echo > /dev/null'), []);
    const after = Number(text(root.execute('showpid')));

    assert.equal(after - before, 1);
});

test('does not fork once per iteration for builtin-only shell loops', () => {
    write_executable('/usr/local/bin/showpid', ctx => {
        ctx.printf(String(ctx.getpid()));
        return 0;
    });
    write_executable(
        '/usr/local/bin/builtin-loop',
        '#!/bin/sh\nwhile true; do echo 1 > /dev/null; done\n',
    );

    const before = Number(text(root.execute('showpid')));
    const output = text(root.execute('/usr/local/bin/builtin-loop'));
    const after = Number(text(root.execute('showpid')));

    assert.match(output, /maximum loop count exceeded/);
    assert.ok(after - before <= 4);
});

test('runs pipeline builtins in child shell state', () => {
    const start_cwd = root.cwd;

    assert.equal(text(root.execute('cd / | pwd')), start_cwd);
    assert.equal(root.cwd, start_cwd);

    assert.equal(text(root.execute('echo child-value | read PIPE_VALUE; printenv PIPE_VALUE')), '');
});

test('pipeline stages receive kernel pipe file descriptors', () => {
    const source = create_program_image(ctx => {
        const self = ctx.list_procs().find(task => task.pid === ctx.getpid());
        ctx.printf(self.fdt[1].kind);
    });
    assert.equal(
        ksyms.syscall(
            root.pid,
            ksyms.nr.__NR_writefile,
            '/tmp/fd-pipeline',
            source,
            false,
        ).err,
        undefined,
    );
    assert.equal(
        ksyms.syscall(
            root.pid,
            ksyms.nr.__NR_chmod,
            '/tmp/fd-pipeline',
            0o755,
        ).err,
        undefined,
    );

    assert.equal(text(root.execute('/tmp/fd-pipeline | cat')), 'pipe');
});

test('redirections are opened before exec and installed as descriptors', () => {
    const source = create_program_image(ctx => {
        const self = ctx.list_procs().find(task => task.pid === ctx.getpid());
        ctx.printf(self.fdt[1].kind);
    });
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/tmp/fd-redirection',
        source,
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/tmp/fd-redirection',
        0o755,
    );

    assert.deepEqual(
        root.execute('/tmp/fd-redirection > /tmp/fd-redirection.out'),
        [],
    );
    assert.equal(text(root.execute('cat /tmp/fd-redirection.out')), 'file');

    root.execute('rm -f /tmp/should-not-run');
    const denied = root.execute(
        'touch /tmp/should-not-run > /missing-parent/output');
    assert.match(text(denied), /Cannot create file|No such file/);
    assert.equal(ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_stat,
        '/tmp/should-not-run',
    ).err, -ksyms.types.ENOENT);
});

test('async pipeline consumers wait for writer EOF', async () => {
    const source = '#!/usr/bin/bash\nsleep 0.02\necho late\n';
    assert.equal(
        ksyms.syscall(
            root.pid,
            ksyms.nr.__NR_writefile,
            '/tmp/slow-pipeline',
            source,
            false,
        ).err,
        undefined,
    );
    assert.equal(
        ksyms.syscall(
            root.pid,
            ksyms.nr.__NR_chmod,
            '/tmp/slow-pipeline',
            0o755,
        ).err,
        undefined,
    );

    const keepalive = delay(50);
    const output = await root.execute_async('/tmp/slow-pipeline | cat');
    await keepalive;
    assert.equal(text(output), 'late');
    assert.equal(root.last_exit_status, 0);
});

test('async redirections are installed before the program starts', async () => {
    const source = '#!/usr/bin/bash\nsleep 0.01\necho async-output\n';
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/tmp/async-redirection',
        source,
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/tmp/async-redirection',
        0o755,
    );

    await Promise.all([
        root.execute_async(
            '/tmp/async-redirection > /tmp/async-redirection.out'),
        delay(30),
    ]);
    assert.equal(
        text(root.execute('cat /tmp/async-redirection.out')),
        'async-output',
    );

    const denied = await root.execute_async(
        '/tmp/async-redirection > /missing-parent/output');
    assert.match(text(denied), /Cannot create file|No such file/);
    const live_sleep = [];
    ksyms.for_each_task(task => {
        if (task.comm === 'sleep') live_sleep.push(task.pid);
    });
    assert.deepEqual(live_sleep, []);
});

test('async pipelines share a foreground process group', async () => {
    const shell = new Bash(0, 0);
    const execution = shell.execute_async('sleep 0.02 | cat');
    await delay(2);

    const stages = [];
    ksyms.for_each_task(task => {
        if (task.ppid === shell.pid && ['sleep', 'cat'].includes(task.comm))
            stages.push(task);
    });
    assert.equal(stages.length, 2);
    assert.equal(stages[0].pgid, stages[0].pid);
    assert.equal(stages[1].pgid, stages[0].pgid);
    assert.equal(stages[1].state, ksyms.types.TASK_SLEEPING);
    assert.equal(
        ksyms.syscall(
            shell.pid,
            ksyms.nr.__NR_ioctl,
            0,
            ksyms.types.TIOCGPGRP,
        ).val,
        stages[0].pgid,
    );

    await Promise.all([execution, delay(30)]);
    assert.equal(
        ksyms.syscall(
            shell.pid,
            ksyms.nr.__NR_ioctl,
            0,
            ksyms.types.TIOCGPGRP,
        ).val,
        shell.pid,
    );
});

test('exec replaces the current shell task without allocating a child command pid', () => {
    write_executable('/usr/local/bin/self-pid', ctx => {
        ctx.printf(String(ctx.getpid()));
        return 7;
    });
    const shell = new Bash(0, 0);
    const shell_pid = shell.pid;

    assert.equal(text(shell.execute('exec self-pid')), String(shell_pid));
    assert.equal(shell.last_exit_status, 7);
    assert.equal(shell.is_alive, false);
});

test('nested interactive bash returns to the parent shell when killed', () => {
    const shell = new Bash(0, 0);
    const parent_pid = shell.pid;

    assert.deepEqual(shell.execute('bash'), []);
    const child_pid = shell.pid;

    assert.notEqual(child_pid, parent_pid);
    assert.equal(ksyms.get_task(child_pid)?.ppid, parent_pid);
    assert.deepEqual(shell.execute(`kill ${child_pid}`), []);
    assert.equal(shell.pid, parent_pid);
    assert.equal(shell.is_alive, true);
    assert.equal(ksyms.get_task(child_pid), null);
    assert.equal(text(shell.execute('echo parent-alive')), 'parent-alive');
});

test('killing a parent interactive bash terminates its active child shell', () => {
    const shell = new Bash(0, 0);
    const parent_pid = shell.pid;

    assert.deepEqual(shell.execute('bash'), []);
    const child_pid = shell.pid;

    assert.notEqual(child_pid, parent_pid);
    assert.deepEqual(shell.execute(`kill ${parent_pid}`), []);
    assert.equal(ksyms.get_task(parent_pid)?.state, ksyms.types.TASK_ZOMBIE);
    assert.equal(ksyms.get_task(child_pid)?.state, ksyms.types.TASK_ZOMBIE);
    assert.equal(shell.is_alive, false);
});

test('supports subshells, command groups, command substitution and jobs', async () => {
    const shell = new Bash(0, 0);
    const start_cwd = shell.cwd;

    assert.equal(text(shell.execute('(cd /; pwd)')), '/');
    assert.equal(shell.cwd, start_cwd);

    assert.deepEqual(shell.execute('{ cd /; }'), []);
    assert.equal(shell.cwd, '/');

    assert.equal(text(shell.execute('echo prefix-$(pwd)-suffix')), 'prefix-/-suffix');
    assert.match(text(shell.execute('echo bg &')), /^\[1\] \d+$/);
    assert.match(text(shell.execute('jobs')), /\[1\]\+ Running\s+echo bg/);
    await delay(10);
    assert.match(text(shell.execute('jobs -l')), /\[1\]\+\s+\d+ Done\s+echo bg/);
    assert.equal(text(await shell.execute_async('fg %1')), 'bg');
});

test('keeps background sleep jobs alive with process state until wait', async () => {
    const shell = new Bash(0, 0);
    const started = text(shell.execute('sleep 0.05 &'));
    const pid = Number(started.match(/\d+$/)[0]);

    assert.equal(ksyms.get_task(pid)?.comm, 'sleep');
    assert.equal(ksyms.get_task(pid)?.state, 'S');
    assert.match(text(shell.execute('jobs -l')), /\[1\]\+\s+\d+ Running\s+sleep 0.05/);

    await delay(80);
    assert.equal(ksyms.get_task(pid), null);
    assert.match(text(shell.execute('jobs -l')), /\[1\]\+\s+\d+ Done\s+sleep 0.05/);
    assert.equal(text(await shell.execute_async('wait %1')), '');
    assert.equal(text(shell.execute('jobs')), '');
});

test('supports foregrounding, waiting and killing background jobs', async () => {
    const shell = new Bash(0, 0);

    assert.match(text(shell.execute('echo captured &')), /^\[1\] \d+$/);
    await delay(10);
    assert.equal(text(await shell.execute_async('fg %1')), 'captured');
    assert.equal(text(shell.execute('jobs')), '');

    const started = text(shell.execute('sleep 1 &'));
    const pid = Number(started.match(/\d+$/)[0]);
    assert.equal(ksyms.get_task(pid)?.state, 'S');
    assert.equal(text(shell.execute('kill %1')), '');
    assert.match(text(shell.execute('jobs -l')), /\[1\]\+\s+\d+ Terminated\s+sleep 1/);
    assert.equal(text(await shell.execute_async('wait %1')), '');
    assert.equal(shell.last_exit_status, 143);
});

test('runs an immediately invoked JSNix script only once', () => {
    const source = [
        '#!/usr/bin/env jsnix-js',
        '(() => {',
        '    ctx.printf("iife executed");',
        '})();',
        '',
    ].join('\n');
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/iife-script',
        source,
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/iife-script',
        0o755,
    );

    const output = root.execute('iife-script');

    assert.equal(text(output), 'iife executed');
    assert.equal(root.last_exit_status, 0);
});

test('lets bash interpret executable text files after ENOEXEC', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/text-script',
        'echo shell:$1\nexit 7\n',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/text-script',
        0o755,
    );

    const output = root.execute('text-script one');

    assert.equal(text(output), 'shell:one');
    assert.equal(root.last_exit_status, 7);
});

test('keeps non-script binary garbage as an exec format error', () => {
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/not-a-program',
        '\0not an elf file',
        false,
    );
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_chmod,
        '/usr/local/bin/not-a-program',
        0o755,
    );

    assert.match(text(root.execute('not-a-program')), /Exec format error/);
    assert.equal(root.last_exit_status, 126);
});

test('uses executable files, PATH and permissions as the source of truth', () => {
    register_binary(
        'file-backed',
        ctx => {
            ctx.printf('from registered image');
            return 0;
        },
        '/usr/local/bin/file-backed',
    );
    assert.equal(
        text(root.execute('file-backed')),
        'from registered image'
    );

    assert.deepEqual(
        root.execute('cp /usr/local/bin/file-backed /tmp/file-backed-copy'),
        []
    );
    assert.equal(
        text(root.execute('/tmp/file-backed-copy')),
        'from registered image'
    );

    root.execute('chmod 0644 /tmp/file-backed-copy');
    assert.match(
        text(root.execute('/tmp/file-backed-copy')),
        /Permission denied/
    );
    assert.equal(root.last_exit_status, 126);

    root.execute('rm /usr/local/bin/file-backed');
    assert.match(
        text(root.execute('file-backed')),
        /command not found/
    );
    assert.equal(root.last_exit_status, 127);
});

test('executes modified program source instead of the registered callback', () => {
    register_binary(
        'replaceable',
        ctx => {
            ctx.printf('old');
            return 0;
        },
        '/usr/local/bin/replaceable',
    );
    const replacement = create_program_image(ctx => {
        ctx.printf(`new:${ctx.args.join(':')}`);
        return 3;
    });
    ksyms.syscall(
        root.pid,
        ksyms.nr.__NR_writefile,
        '/usr/local/bin/replaceable',
        replacement,
        false,
    );

    assert.equal(text(root.execute('replaceable a b')), 'new:a:b');
    assert.equal(root.last_exit_status, 3);
});

test('completes the active token without adding whitespace', () => {
    assert.deepEqual(
        tty_replace_completion('ec', 2, 'echo'),
        {value: 'echo', cursor: 4}
    );
    assert.deepEqual(
        tty_replace_completion('cat /tm suffix', 7, '/tmp'),
        {value: 'cat /tmp suffix', cursor: 8}
    );
    assert.ok(bash_tab_complete(root, 'ls ').includes('.bashrc'));
});

test('prints ambiguous tab completions in the terminal stream', () => {
    const tty = create_tty({login: false, uid: 0});
    const output = [];
    const input = [];
    let popup_events = 0;

    tty.on('output', item => output.push(item));
    tty.on('input', item => input.push(item));
    tty.on('completions', () => popup_events++);
    tty.start();
    output.length = 0;
    input.length = 0;

    tty.handleKey('Tab', {value: 'ech', cursor: 3});
    assert.deepEqual(input.at(-1), {
        value: 'echo',
        cursor: 4,
        secure: false,
    });

    output.length = 0;
    input.length = 0;
    tty.handleKey('Tab', {value: 'mk', cursor: 2});
    const printed = text(output);

    assert.match(printed, /\bmkdir\b/);
    assert.match(printed, /\bmktemp\b/);
    assert.equal(input.length, 0);
    assert.equal(popup_events, 0);
    tty.destroy();
});

test('moves through history without skipping the newest command', () => {
    const history = ['echo first', 'echo second'];
    const state = {hist_idx: history.length, hist_draft: ''};

    assert.equal(
        tty_move_history(history, state, -1, 'unfinished'),
        'echo second'
    );
    assert.equal(
        tty_move_history(history, state, -1, 'echo second'),
        'echo first'
    );
    assert.equal(
        tty_move_history(history, state, 1, 'echo first'),
        'echo second'
    );
    assert.equal(
        tty_move_history(history, state, 1, 'echo second'),
        'unfinished'
    );
});

test('keeps script commands out of the current TTY history', () => {
    write_executable(
        '/usr/local/bin/history-script',
        '#!/bin/sh\necho script-one\npwd\n',
    );
    const tty = create_tty({login: false, uid: 0});
    const input = [];

    tty.on('input', item => input.push(item));
    tty.start();
    input.length = 0;

    tty.submit('history-script');
    tty.handleKey('ArrowUp', {value: '', cursor: 0});
    assert.equal(input.at(-1).value, 'history-script');

    tty.handleKey('ArrowUp', {value: 'history-script', cursor: 14});
    assert.equal(input.at(-1).value, 'history-script');

    tty.destroy();
});

test('provides a Debian-style FHS root file system', () => {
    for (const path of [
        '/boot',
        '/dev',
        '/etc',
        '/home',
        '/media',
        '/mnt',
        '/opt',
        '/proc',
        '/root',
        '/run',
        '/srv',
        '/sys',
        '/tmp',
        '/usr',
        '/var',
        '/usr/local/bin',
        '/usr/share/man/man1',
        '/var/cache',
        '/var/lib',
        '/var/log',
        '/var/mail',
        '/var/spool',
    ]) {
        assert.equal(ksyms.path_lookup(path)?.i_type, 'dir', path);
    }

    assert.equal(ksyms.path_lstat('/bin').i_data, '/usr/bin');
    assert.equal(ksyms.path_lstat('/sbin').i_data, '/usr/sbin');
    assert.equal(ksyms.path_lstat('/lib').i_data, '/usr/lib');
    assert.equal(ksyms.path_lstat('/var/run').i_data, '/run');
    assert.equal(ksyms.path_lstat('/var/lock').i_data, '/run/lock');
    assert.equal(ksyms.path_lookup('/tmp').i_mode & 0o7777, 0o1777);
    assert.equal(ksyms.path_lookup('/var/tmp').i_mode & 0o7777, 0o1777);
});

test('handles symlinked working directories like GNU ls', () => {
    const shell = new Bash(0, 0);

    shell.execute('cd /');
    assert.match(text(shell.execute('ls -al')), /bin -> \/usr\/bin/);
    assert.match(text(shell.execute('ls -al /bin')), /bin -> \/usr\/bin/);

    shell.execute('cd /bin');
    const working_directory = text(shell.execute('ls -al'));
    assert.match(working_directory, /\bls\b/);
    assert.doesNotMatch(working_directory, /bin -> \/usr\/bin/);

    const trailing_slash = text(shell.execute('ls -al /bin/'));
    assert.match(trailing_slash, /\bls\b/);
    assert.doesNotMatch(trailing_slash, /bin -> \/usr\/bin/);

    assert.match(text(shell.execute('ls -ald .')), /^d/);
    assert.match(text(shell.execute('ls -ald /bin')), /^l/);
});

test('provides standard Linux account and configuration files', () => {
    assert.match(text(root.execute('cat /etc/passwd')), /^root:x:0:0:/);
    assert.match(text(root.execute('cat /etc/passwd')), /^nobody:x:65534:65534:/m);
    assert.match(text(root.execute('cat /etc/group')), /^shadow:x:42:/m);
    assert.match(text(root.execute('cat /etc/hosts')), /^127\.0\.0\.1\s+localhost/m);
    assert.match(text(root.execute('cat /etc/nsswitch.conf')), /^hosts:\s+files dns/m);
    assert.match(text(root.execute('cat /etc/fstab')), /^proc\s+\/proc\s+proc/m);
    assert.match(text(root.execute('cat /etc/os-release')), /^ID_LIKE=debian/m);
    assert.equal(ksyms.path_lookup('/etc/shadow').i_mode & 0o777, 0o640);
    assert.equal(ksyms.path_lookup('/etc/shadow').i_gid, 42);
    assert.equal(ksyms.path_lookup('/etc/gshadow').i_mode & 0o777, 0o640);
});

test('provides device, proc and sys pseudo-file system entries', () => {
    assert.equal(ksyms.path_lookup('/dev/null').i_type, 'char');
    assert.equal(ksyms.path_lookup('/dev/tty').i_type, 'char');
    assert.equal(text(root.execute('cat /dev/null')), '');
    assert.equal(ksyms.path_lookup('/dev/random').i_type, 'char');
    assert.equal(ksyms.path_lookup('/dev/urandom').i_type, 'char');

    const random_a = ksyms.syscall(root.pid, ksyms.nr.__NR_readfile, '/dev/random');
    const random_b = ksyms.syscall(root.pid, ksyms.nr.__NR_readfile, '/dev/random');
    assert.equal(random_a.val.length, 32);
    assert.equal(random_b.val.length, 32);
    assert.notEqual(random_a.val, random_b.val);
    assert.equal(ksyms.path_lookup('/dev/random').i_data, '');

    assert.match(text(root.execute('cat /proc/cpuinfo')), /JavaScript Virtual CPU/);
    assert.match(text(root.execute('cat /proc/self/status')), /^Name:\tcat/m);
    assert.equal(text(root.execute('cat /sys/class/net/eth0/operstate')), 'up');
    assert.equal(
        text(root.execute('cat /sys/class/net/eth0/address')),
        '02:00:00:00:00:01'
    );
});

test('provides a renderer-independent TTY event API', () => {
    const tty = create_tty({login: false, uid: 0});
    const events = [];
    tty.on('*', event => events.push(event));

    tty.start();
    tty.submit('echo core');
    tty.submit('ls /tmp/highlight');
    tty.handleKey('ArrowUp', {value: '', cursor: 0});

    assert.ok(events.some(event =>
        event.type === 'output' && event.payload.text === 'core'));
    assert.ok(events.some(event =>
        event.type === 'echo' && event.payload.text === 'echo core'));
    assert.ok(events.some(event =>
        event.type === 'prompt' && event.payload.kind === 'shell'));
    assert.ok(events.some(event =>
        event.type === 'input' &&
        event.payload.value === 'ls /tmp/highlight'));
    assert.ok(events.some(event =>
        event.type === 'output' &&
        event.payload.segments?.some(segment =>
            segment.text === 'directory' &&
            segment.role === 'directory')));
    assert.equal(typeof document, 'undefined');
    tty.destroy();
});

test('killing a non-login TTY shell ends the session without respawn', async () => {
    const tty = create_tty({login: false, uid: 0, respawn_delay: 5});
    const outputs = [];
    tty.on('output', output => outputs.push(output.text ?? ''));

    tty.start();
    const shell_pid = tty.shell.pid;
    const killed = ksyms.syscall(
        shell_pid,
        ksyms.nr.__NR_kill,
        shell_pid,
        ksyms.types.SIGTERM,
    );

    assert.equal(killed.err, undefined);
    assert.equal(ksyms.get_task(shell_pid).state, ksyms.types.TASK_ZOMBIE);
    assert.equal(tty.shell, null);
    assert.equal(tty.prompt.kind, 'dead');
    assert.equal(tty.state.alive, false);
    assert.match(outputs.join('\n'), /session ended/);
    assert.doesNotMatch(outputs.join('\n'), /respawning/);

    await delay(20);
    assert.equal(tty.shell, null);
    assert.equal(tty.state.alive, false);
    tty.destroy();
});

test('TTY nested bash returns to the parent shell when the child dies', () => {
    const tty = create_tty({login: false, uid: 0});

    tty.start();
    const parent_pid = tty.shell.pid;
    tty.submit('bash');
    const child_pid = tty.shell.pid;

    assert.notEqual(child_pid, parent_pid);
    assert.equal(ksyms.get_task(child_pid)?.ppid, parent_pid);

    tty.submit(`kill ${child_pid}`);

    assert.equal(tty.shell.pid, parent_pid);
    assert.equal(tty.state.alive, true);
    assert.equal(tty.prompt.kind, 'shell');
    assert.equal(ksyms.get_task(child_pid), null);
    tty.destroy();
});

test('TTY waits for async foreground commands before returning a prompt', async () => {
    const tty = create_tty({login: false, uid: 0});
    const events = [];
    tty.on('*', event => events.push(event));

    tty.start();
    events.length = 0;
    tty.submit('sleep 0.02 && echo awake');

    assert.equal(events.some(event =>
        event.type === 'output' && event.payload.text === 'awake'), false);
    assert.equal(live_pids('sleep').length, 1);
    await delay(50);
    assert.equal(live_pids('sleep').length, 0);
    assert.ok(events.some(event =>
        event.type === 'output' && event.payload.text === 'awake'));
    assert.equal(events.at(-1).type, 'state');
    assert.ok(events.some(event =>
        event.type === 'prompt' && event.payload.kind === 'shell'));
    tty.destroy();
});

test('TTY runs shell scripts with async external commands through real processes', async () => {
    const tty = create_tty({login: false, uid: 0});
    const outputs = [];
    tty.on('output', output => outputs.push(output));
    tty.start();

    const write = ksyms.syscall(
        tty.shell.pid,
        ksyms.nr.__NR_writefile,
        '/tmp/tty-async-script.sh',
        '#!/usr/bin/bash\nsleep 0.02\necho script-awake\n',
        false,
    );
    assert.equal(write.err, undefined);
    const chmod = ksyms.syscall(
        tty.shell.pid,
        ksyms.nr.__NR_chmod,
        '/tmp/tty-async-script.sh',
        0o755,
    );
    assert.equal(chmod.err, undefined);

    outputs.length = 0;
    tty.submit('/tmp/tty-async-script.sh');

    assert.equal(live_pids('sleep').length, 1);
    await delay(50);
    assert.equal(live_pids('sleep').length, 0);
    assert.ok(outputs.some(output => output.text === 'script-awake'));
    assert.equal(
        outputs.some(output =>
            /asynchronous program requires async exec/.test(output.text ?? '')),
        false,
    );
    tty.destroy();
});

test('runs a minimal vi/vim foreground editor session', () => {
    const tty = create_tty({login: false, uid: 0});
    const screens = [];
    const app_exits = [];
    const prompts = [];

    tty.on('app-screen', screen => screens.push(screen));
    tty.on('app-exit', screen => app_exits.push(screen));
    tty.on('prompt', prompt => prompts.push(prompt));
    tty.start();
    screens.length = 0;
    prompts.length = 0;

    tty.submit('vim /tmp/vim.txt');
    assert.equal(screens.at(-1)?.editor, 'vim');
    assert.equal(screens.at(-1)?.path, '/tmp/vim.txt');
    assert.equal(prompts.at(-1)?.kind, 'app');
    const vim_pids = live_pids('vim');
    assert.equal(vim_pids.length, 1);
    assert.equal(ksyms.get_task(vim_pids[0])?.state, ksyms.types.TASK_SLEEPING);
    assert.equal(tty.state.application?.pid, vim_pids[0]);

    for (const key of ['i', 'h', 'e', 'l', 'l', 'o', 'Escape', ':', 'w', 'q', 'Enter'])
        tty.handleKey(key);

    assert.equal(app_exits.length, 1);
    assert.equal(live_pids('vim').includes(vim_pids[0]), false);
    assert.equal(text(tty.shell.execute('cat /tmp/vim.txt')), 'hello');
    assert.equal(prompts.at(-1)?.kind, 'shell');
    tty.destroy();
});

test('killing a foreground vim process closes the TTY application session', () => {
    const tty = create_tty({login: false, uid: 0});
    let exited = 0;

    tty.on('app-exit', () => exited++);
    tty.start();
    tty.submit('vi /tmp/killed.txt');

    const [pid] = live_pids('vi');
    assert.ok(pid > 1);
    assert.equal(tty.state.application?.pid, pid);

    ksyms.syscall(tty.shell.pid, ksyms.nr.__NR_kill, pid, ksyms.types.SIGTERM);

    assert.equal(exited, 1);
    assert.equal(tty.state.application, null);
    assert.equal(live_pids('vi').includes(pid), false);
    tty.destroy();
});

test('vi refuses to quit dirty buffers without force', () => {
    const tty = create_tty({login: false, uid: 0});
    const screens = [];
    let exited = 0;

    tty.on('app-screen', screen => screens.push(screen));
    tty.on('app-exit', () => exited++);
    tty.start();
    screens.length = 0;

    tty.submit('vi /tmp/dirty.txt');
    for (const key of ['i', 'x', 'Escape', ':', 'q', 'Enter'])
        tty.handleKey(key);

    assert.equal(exited, 0);
    assert.match(screens.at(-1)?.status ?? '', /No write since last change/);

    for (const key of [':', 'q', '!', 'Enter'])
        tty.handleKey(key);
    assert.equal(exited, 1);
    assert.doesNotMatch(text(tty.shell.execute('ls /tmp')), /dirty\.txt/);
    tty.destroy();
});

test('allows applications to inject TTY process environment variables', () => {
    const tty = create_tty({
        login: false,
        uid: 0,
        env: {
            JSLINUX_SAMPLE: 'injected',
        },
    });
    const outputs = [];
    tty.on('output', output => outputs.push(output));

    tty.start();
    tty.submit('printenv JSLINUX_SAMPLE');

    assert.ok(outputs.some(output =>
        output.text === 'injected'));
    tty.destroy();
});

test('TTY login flow emits semantic prompts without DOM state', () => {
    const tty = create_tty({login: true});
    const prompts = [];
    const outputs = [];
    tty.on('prompt', prompt => prompts.push(prompt));
    tty.on('output', output => outputs.push(output));

    tty.start();
    tty.submit('root');
    tty.submit('root');

    assert.equal(prompts[0].kind, 'login');
    assert.ok(prompts.some(prompt => prompt.kind === 'password'));
    assert.equal(prompts.at(-1).kind, 'shell');
    assert.ok(outputs.some(output => output.text.startsWith('Last login:')));
    tty.destroy();
});

test('TTY login accepts the Blog Security admin credentials', () => {
    const tty = create_tty({login: true});
    const states = [];
    tty.on('state', state => states.push(state));

    tty.start();
    tty.submit('admin');
    tty.submit('admin');

    assert.equal(states.at(-1).user, 'admin');
    assert.equal(states.at(-1).cwd, '/home/admin');
    tty.destroy();
});
