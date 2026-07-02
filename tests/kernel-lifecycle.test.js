import assert from 'node:assert/strict';
import test from 'node:test';

import {
    create_kernel,
    create_test_kernel,
    default_kernel,
} from '../src/runtime/kernel.js';
import {Bash} from '../src/usr/shell/bash.js';
import {
    authenticate,
    make_shadow_hash,
} from '../src/kernel/security/credentials.js';
import {ksyms} from '../src/kernel/ksyms.js';

function text(lines) {
    return lines.map(line => line.text ?? '').join('\n');
}

test('kernel facade boots explicitly and can reset the singleton backend', () => {
    assert.equal(default_kernel.booted, false);
    assert.equal(default_kernel.inspect.tasks().length, 0);

    const kernel = create_kernel({name: 'lifecycle'});
    assert.equal(kernel.booted, false);
    kernel.boot();

    assert.equal(kernel.booted, true);
    assert.equal(kernel.boot_state.pid1, 1);
    assert.equal(
        kernel.inspect.tasks().filter(task => task.comm === 'init').length,
        1,
    );
    assert.equal(kernel.inspect.getUser('guest').username, 'guest');

    kernel.reset();

    assert.equal(kernel.booted, false);
    assert.equal(kernel.boot_state.pid1, null);
    assert.equal(kernel.inspect.tasks().length, 0);
    assert.equal(kernel.inspect.getUser('guest'), null);
    assert.equal(kernel.inspect.stat('/etc/passwd'), null);
});

test('create_test_kernel resets before returning a facade', () => {
    const kernel = create_test_kernel({name: 'fresh'});

    assert.equal(kernel.name, 'fresh');
    assert.equal(kernel.booted, false);
    assert.equal(kernel.inspect.tasks().length, 0);

    kernel.boot();

    assert.equal(kernel.boot_state.pid1, 1);
    assert.equal(
        kernel.inspect.tasks().filter(task => task.comm === 'init').length,
        1,
    );
    assert.equal(kernel.inspect.getUser('root').uid, 0);
});

test('uses Linux x86-64 numbers for the compatible syscall subset', () => {
    const {nr} = ksyms;
    assert.deepEqual(
        [nr.__NR_read, nr.__NR_write, nr.__NR_open, nr.__NR_close],
        [0, 1, 2, 3],
    );
    assert.equal(nr.__NR_wait4, 61);
    assert.equal(nr.__NR_kill, 62);
    assert.equal(nr.__NR_uname, 63);
});

test('PID 1 is protected from user-space signals', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;

    const killed = ksyms.syscall(
        root.pid,
        nr.__NR_kill,
        types.INIT_PID,
        types.SIGTERM,
    );

    assert.equal(killed.err, -types.EPERM);
    assert.equal(ksyms.get_task(types.INIT_PID).state, types.TASK_RUNNING);
    assert.equal(ksyms.power_state().state, 'running');
    assert.match(text(root.execute('kill 1')), /Operation not permitted/);
});

test('PID 1 exit puts the kernel into panic', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const {nr, types} = ksyms;

    const exited = ksyms.syscall(types.INIT_PID, nr.__NR_exit, 7);

    assert.equal(exited.err, undefined);
    assert.equal(ksyms.get_task(types.INIT_PID).state, types.TASK_ZOMBIE);
    assert.equal(ksyms.get_task(types.INIT_PID).exit_code, 7);
    assert.equal(ksyms.power_state().state, 'panic');
    assert.match(ksyms.power_state().reason, /init exited with status 7/);
});

test('exiting parent reparents live children to PID 1', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const parent = new Bash(0, 0);
    const {nr, types} = ksyms;
    const child = ksyms.kernel_spawn('child', 0, 0, parent.cwd, parent.pid);

    assert.equal(ksyms.get_task(child).ppid, parent.pid);

    const exited = ksyms.syscall(parent.pid, nr.__NR_exit, 0);

    assert.equal(exited.err, undefined);
    assert.equal(ksyms.get_task(parent.pid).state, types.TASK_ZOMBIE);
    assert.equal(ksyms.get_task(child).ppid, types.INIT_PID);
    assert.equal(ksyms.get_task(child).state, types.TASK_RUNNING);
});

test('rootfs can boot without the optional guest account', () => {
    const kernel = create_test_kernel({
        name: 'no-guest',
        include_guest: false,
    });

    kernel.boot();

    const root = new Bash(0, 0);
    assert.equal(kernel.inspect.getUser('root').uid, 0);
    assert.equal(kernel.inspect.getUser('guest'), null);
    assert.doesNotMatch(
        root.execute('cat /etc/passwd').map(line => line.text ?? '').join('\n'),
        /^guest:/m,
    );
    assert.equal(
        root.execute('cat /etc/subuid').map(line => line.text ?? '').join('\n'),
        '',
    );
});

test('root password can be configured at boot', () => {
    const kernel = create_test_kernel({
        name: 'root-password',
        root_password: 'toor',
    });

    kernel.boot();

    assert.equal(authenticate('root', 'root'), null);
    assert.equal(authenticate('root', 'toor').uid, 0);
});

test('rootfs can boot with configured default accounts', () => {
    const kernel = create_test_kernel({
        name: 'accounts',
        include_guest: false,
        users: [{
            username: 'alice',
            password: 'alicepw',
            gecos: 'Alice Example',
            groups: [100],
        }],
    });

    kernel.boot();

    const root = new Bash(0, 0);
    const alice = kernel.inspect.getUser('alice');

    assert.equal(kernel.inspect.getUser('guest'), null);
    assert.equal(alice.uid, 1000);
    assert.equal(alice.gid, 1000);
    assert.deepEqual(alice.groups, [1000, 100]);
    assert.equal(authenticate('alice', 'alicepw').home, '/home/alice');
    assert.equal(kernel.inspect.stat('/home/alice').uid, 1000);
    assert.match(
        root.execute('cat /etc/passwd').map(line => line.text ?? '').join('\n'),
        /^alice:x:1000:1000:Alice Example:\/home\/alice:\/bin\/bash$/m,
    );
    assert.match(
        root.execute('cat /etc/group').map(line => line.text ?? '').join('\n'),
        /^alice:x:1000:alice$/m,
    );
    assert.match(
        root.execute('cat /etc/subuid').map(line => line.text ?? '').join('\n'),
        /^alice:100000:65536$/m,
    );
});

test('credentials reload users and groups from account files', () => {
    const kernel = create_test_kernel({
        name: 'file-accounts',
        include_guest: false,
    });
    kernel.boot();

    ksyms.path_lookup('/etc/passwd').i_data +=
        'fileuser:x:1500:1500:File User:/home/fileuser:/bin/bash\n';
    ksyms.path_lookup('/etc/group').i_data +=
        'fileuser:x:1500:fileuser\n';
    ksyms.path_lookup('/etc/shadow').i_data +=
        `fileuser:${make_shadow_hash('filepw')}:19000:0:99999:7:::\n`;

    assert.equal(authenticate('fileuser', 'bad'), null);
    assert.equal(authenticate('fileuser', 'filepw').uid, 1500);
    assert.equal(kernel.inspect.getUser('fileuser').home, '/home/fileuser');
    assert.deepEqual(kernel.inspect.getGroup('fileuser').members, ['fileuser']);
});

test('hostname and TTY banner are read from rootfs files', () => {
    const kernel = create_test_kernel({
        name: 'file-config',
        hostname: 'labhost',
        issue: 'Lab Banner\nAuthorized access only\n',
    });

    kernel.boot();

    const root = new Bash(0, 0);
    assert.equal(text(root.execute('hostname')), 'labhost');
    assert.match(text(root.execute('uname -a')), /^JSNix labhost /);

    const tty = kernel.create_tty({login: false, uid: 0});
    const output = [];
    tty.on('output', line => output.push(line.text ?? ''));
    tty.start();

    assert.equal(output[0], 'Lab Banner');
    assert.equal(output[1], 'Authorized access only');
    tty.destroy();

    root.execute('hostname changed');
    assert.equal(text(root.execute('sysctl kernel.hostname')), 'kernel.hostname = changed');
    assert.match(text(root.execute('uname -a')), /^JSNix changed /);
});

test('kernel reset clears user-space mutable program and shell state', () => {
    const kernel = create_test_kernel();
    kernel.boot();

    const root = new Bash(0, 0);
    root.execute('mktemp');
    root.execute('sysctl -w kernel.hostname=changed');
    root.execute('modprobe demo');

    assert.ok(root.history.length > 0);
    assert.match(
        root.execute('sysctl kernel.hostname')[0].text,
        /changed/,
    );
    assert.match(
        root.execute('lsmod').map(line => line.text ?? '').join('\n'),
        /demo/,
    );

    kernel.reset();
    kernel.boot();

    const fresh_root = new Bash(0, 0);

    assert.equal(fresh_root.history.length, 0);
    assert.match(
        fresh_root.execute('sysctl kernel.hostname')[0].text,
        /jsnix/,
    );
    assert.doesNotMatch(
        fresh_root.execute('lsmod').map(line => line.text ?? '').join('\n'),
        /demo/,
    );
});

test('file descriptors support open, seek, dup, append and pipes', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;
    const sc = (number, ...args) => {
        const result = ksyms.syscall(root.pid, number, ...args);
        assert.equal(result.err, undefined);
        return result.val;
    };

    const fd = sc(
        nr.__NR_open,
        '/tmp/fd.txt',
        types.O_CREAT | types.O_RDWR | types.O_TRUNC,
        0o644,
    );
    assert.equal(sc(nr.__NR_write, fd, 'abcdef'), 6);
    assert.equal(sc(nr.__NR_lseek, fd, 0, types.SEEK_SET), 0);
    assert.equal(sc(nr.__NR_read, fd, 2), 'ab');

    const dup = sc(nr.__NR_dup, fd);
    assert.equal(sc(nr.__NR_read, dup, 2), 'cd');
    assert.equal(sc(nr.__NR_read, fd), 'ef');
    assert.equal(sc(nr.__NR_close, dup), 0);
    assert.equal(sc(nr.__NR_close, fd), 0);

    const append = sc(nr.__NR_open, '/tmp/fd.txt', types.O_WRONLY | types.O_APPEND);
    assert.equal(sc(nr.__NR_lseek, append, 0, types.SEEK_SET), 0);
    assert.equal(sc(nr.__NR_write, append, 'Z'), 1);
    assert.equal(sc(nr.__NR_close, append), 0);
    assert.equal(text(root.execute('cat /tmp/fd.txt')), 'abcdefZ');

    const [readfd, writefd] = sc(nr.__NR_pipe);
    assert.equal(sc(nr.__NR_write, writefd, 'pipe-data'), 9);
    assert.equal(sc(nr.__NR_read, readfd, 4), 'pipe');
    assert.equal(sc(nr.__NR_read, readfd), '-data');
    assert.equal(sc(nr.__NR_close, readfd), 0);
    assert.equal(sc(nr.__NR_close, writefd), 0);
});

test('forked tasks inherit open file descriptions', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;
    const sc = (pid, number, ...args) => {
        const result = ksyms.syscall(pid, number, ...args);
        assert.equal(result.err, undefined);
        return result.val;
    };

    const fd = sc(
        root.pid,
        nr.__NR_open,
        '/tmp/shared-offset.txt',
        types.O_CREAT | types.O_RDWR | types.O_TRUNC,
        0o644,
    );
    sc(root.pid, nr.__NR_write, fd, 'abcdef');
    sc(root.pid, nr.__NR_lseek, fd, 0, types.SEEK_SET);

    const child = ksyms.kernel_spawn('child', 0, 0, root.cwd, root.pid);
    assert.equal(sc(child, nr.__NR_read, fd, 3), 'abc');
    assert.equal(sc(root.pid, nr.__NR_read, fd), 'def');
});

test('regular-file offsets and sizes are measured in UTF-8 bytes', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;
    const fd = ksyms.syscall(
        root.pid,
        nr.__NR_open,
        '/tmp/utf8.txt',
        types.O_CREAT | types.O_RDWR | types.O_TRUNC,
        0o644,
    ).val;

    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_write, fd, '😀'),
        {val: 4},
    );
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_lseek, fd, 0, types.SEEK_END),
        {val: 4},
    );
    ksyms.syscall(root.pid, nr.__NR_lseek, fd, 0, types.SEEK_SET);
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_read, fd, 4),
        {val: '😀'},
    );
    assert.equal(
        ksyms.syscall(root.pid, nr.__NR_stat, '/tmp/utf8.txt').val.st_size,
        4,
    );

    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_truncate, '/tmp/utf8.txt', 6),
        {val: 0},
    );
    assert.equal(
        ksyms.syscall(root.pid, nr.__NR_stat, '/tmp/utf8.txt').val.st_size,
        6,
    );
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_truncate, '/tmp/utf8.txt', -1),
        {err: -types.EINVAL},
    );
});

test('duplicated and inherited pipe endpoints stay open until the last close', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;

    const [readfd, writefd] = ksyms.syscall(
        root.pid, nr.__NR_pipe).val;
    const duplicate = ksyms.syscall(
        root.pid, nr.__NR_dup, readfd).val;
    assert.deepEqual(ksyms.syscall(root.pid, nr.__NR_close, readfd), {val: 0});
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_write, writefd, 'x'),
        {val: 1},
    );
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_read, duplicate, 1),
        {val: 'x'},
    );

    const child = ksyms.kernel_spawn('pipe-child', 0, 0, '/', root.pid);
    assert.deepEqual(ksyms.syscall(root.pid, nr.__NR_close, duplicate), {val: 0});
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_write, writefd, 'y'),
        {val: 1},
    );
    assert.deepEqual(
        ksyms.syscall(child, nr.__NR_read, duplicate, 1),
        {val: 'y'},
    );

    assert.deepEqual(ksyms.syscall(child, nr.__NR_exit, 0), {val: 0});
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_write, writefd, 'z'),
        {err: -types.EPIPE},
    );
});

test('rename and symlink traversal follow Linux namei rules', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;

    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_stat, ''),
        {err: -types.ENOENT},
    );

    root.execute('echo keep > /tmp/same');
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_rename, '/tmp/same', '/tmp/same'),
        {val: 0},
    );
    assert.equal(text(root.execute('cat /tmp/same')), 'keep');

    root.execute('mkdir -p /tmp/source /tmp/target');
    root.execute('echo occupied > /tmp/target/file');
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_rename, '/tmp/source', '/tmp/target'),
        {err: -types.ENOTEMPTY},
    );
    assert.equal(text(root.execute('cat /tmp/target/file')), 'occupied');

    root.execute('mkdir -p /tmp/real/dir');
    root.execute('echo physical > /tmp/real/x');
    root.execute('echo lexical > /tmp/x');
    assert.deepEqual(
        ksyms.syscall(
            root.pid,
            nr.__NR_symlink,
            '/tmp/real/dir',
            '/tmp/link',
        ),
        {val: 0},
    );
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_readfile, '/tmp/link/../x'),
        {val: 'physical\n'},
    );
    assert.equal(text(root.execute('cat /tmp/link/../x')), 'physical');

    const before = ksyms.syscall(root.pid, nr.__NR_stat, '/tmp').val.st_nlink;
    root.execute('mkdir /tmp/nlink-dir');
    assert.equal(
        ksyms.syscall(root.pid, nr.__NR_stat, '/tmp').val.st_nlink,
        before + 1,
    );
    root.execute('rmdir /tmp/nlink-dir');
    assert.equal(
        ksyms.syscall(root.pid, nr.__NR_stat, '/tmp').val.st_nlink,
        before,
    );
});

test('signals stop and continue tasks while wait4 alone reaps zombies', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;
    const child = ksyms.kernel_spawn('signal-child', 0, 0, '/', root.pid);

    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_kill, child, types.SIGSTOP),
        {val: 0},
    );
    assert.equal(ksyms.get_task(child).state, types.TASK_STOPPED);
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_kill, child, types.SIGCONT),
        {val: 0},
    );
    assert.equal(ksyms.get_task(child).state, types.TASK_RUNNING);
    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_kill, child, types.SIGTERM),
        {val: 0},
    );
    assert.equal(ksyms.get_task(child).state, types.TASK_ZOMBIE);
    assert.deepEqual(
        ksyms.syscall(child, nr.__NR_getpid),
        {err: -types.ESRCH},
    );
    assert.match(
        ksyms.syscall(root.pid, nr.__NR_readfile, `/proc/${child}/status`).val,
        /State:\tZ \(zombie\)/,
    );

    assert.deepEqual(
        ksyms.syscall(root.pid, nr.__NR_wait4, child, 0),
        {
            val: {
                pid: child,
                status: types.SIGTERM,
                exit_code: null,
                signal: types.SIGTERM,
            },
        },
    );
    assert.equal(ksyms.get_task(child), null);
});

test('process groups receive signals together and own the foreground TTY', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const shell = new Bash(0, 0);
    const {nr, types} = ksyms;
    const shell_task = ksyms.get_task(shell.pid);

    assert.equal(shell_task.pgid, shell.pid);
    assert.equal(shell_task.sid, types.INIT_PID);

    const first = ksyms.kernel_spawn('first', 0, 0, '/', shell.pid);
    const second = ksyms.kernel_spawn('second', 0, 0, '/', shell.pid);
    assert.deepEqual(
        ksyms.syscall(shell.pid, nr.__NR_setpgid, first, first),
        {val: 0},
    );
    assert.deepEqual(
        ksyms.syscall(shell.pid, nr.__NR_setpgid, second, first),
        {val: 0},
    );
    assert.equal(ksyms.syscall(
        shell.pid, nr.__NR_getpgid, second).val, first);

    assert.deepEqual(
        ksyms.syscall(
            shell.pid, nr.__NR_ioctl, 0, types.TIOCSPGRP, first),
        {val: 0},
    );
    assert.equal(
        ksyms.syscall(
            shell.pid, nr.__NR_ioctl, 0, types.TIOCGPGRP).val,
        first,
    );

    assert.deepEqual(
        ksyms.syscall(shell.pid, nr.__NR_kill, -first, types.SIGSTOP),
        {val: 0},
    );
    assert.equal(ksyms.get_task(first).state, types.TASK_STOPPED);
    assert.equal(ksyms.get_task(second).state, types.TASK_STOPPED);
    assert.deepEqual(
        ksyms.syscall(shell.pid, nr.__NR_wait4, first, types.WUNTRACED),
        {
            val: {
                pid: first,
                status: (types.SIGSTOP << 8) | 0x7f,
                exit_code: null,
                signal: types.SIGSTOP,
            },
        },
    );
    ksyms.syscall(shell.pid, nr.__NR_kill, -first, types.SIGCONT);
    assert.equal(ksyms.get_task(first).state, types.TASK_RUNNING);
    assert.equal(ksyms.get_task(second).state, types.TASK_RUNNING);
    assert.deepEqual(
        ksyms.syscall(shell.pid, nr.__NR_wait4, first, types.WCONTINUED),
        {
            val: {
                pid: first,
                status: 0xffff,
                exit_code: null,
                signal: null,
            },
        },
    );

    ksyms.syscall(shell.pid, nr.__NR_kill, -first, types.SIGTERM);
    assert.equal(ksyms.get_task(first).state, types.TASK_ZOMBIE);
    assert.equal(ksyms.get_task(second).state, types.TASK_ZOMBIE);
    ksyms.syscall(shell.pid, nr.__NR_wait4, first, 0);
    ksyms.syscall(shell.pid, nr.__NR_wait4, second, 0);
});

test('time syscall reports whole seconds since the Unix epoch', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const before = Math.floor(Date.now() / 1000);
    const result = ksyms.syscall(root.pid, ksyms.nr.__NR_time);
    const after = Math.floor(Date.now() / 1000);

    assert.equal(result.err, undefined);
    assert.ok(result.val >= before && result.val <= after);
});

test('TTY descriptors expose lightweight termios and winsize state', () => {
    const kernel = create_test_kernel();
    kernel.boot();
    const root = new Bash(0, 0);
    const {nr, types} = ksyms;
    const sc = (number, ...args) => {
        const result = ksyms.syscall(root.pid, number, ...args);
        assert.equal(result.err, undefined);
        return result.val;
    };

    assert.equal(sc(nr.__NR_isatty, 0), true);
    const tty_fd = sc(nr.__NR_open, '/dev/tty', types.O_RDWR);
    assert.equal(sc(nr.__NR_isatty, tty_fd), true);
    const file_fd = sc(
        nr.__NR_open,
        '/tmp/not-a-tty',
        types.O_CREAT | types.O_RDWR | types.O_TRUNC,
        0o644,
    );
    assert.equal(sc(nr.__NR_isatty, file_fd), false);

    const termios = sc(nr.__NR_tcgetattr, 0);
    assert.ok(termios.lflag & types.ECHO);
    assert.ok(termios.lflag & types.ICANON);
    sc(nr.__NR_tcsetattr, 0, {
        ...termios,
        lflag: termios.lflag & ~types.ECHO & ~types.ICANON,
    });
    const raw = sc(nr.__NR_tcgetattr, tty_fd);
    assert.equal(raw.lflag & types.ECHO, 0);
    assert.equal(raw.lflag & types.ICANON, 0);

    assert.deepEqual(
        sc(nr.__NR_ioctl, 0, types.TIOCGWINSZ),
        {rows: 24, cols: 80, xpixel: 0, ypixel: 0},
    );
    sc(nr.__NR_ioctl, 0, types.TIOCSWINSZ, {rows: 40, cols: 120});
    assert.deepEqual(
        sc(nr.__NR_ioctl, tty_fd, types.TIOCGWINSZ),
        {rows: 40, cols: 120, xpixel: 0, ypixel: 0},
    );

    assert.match(text(root.execute('stty -a')), /rows 40; columns 120/);
    assert.match(text(root.execute('stty -a')), /-icanon -echo/);
    assert.deepEqual(root.execute('stty sane'), []);
    assert.match(text(root.execute('stty -a')), /icanon echo/);
});
