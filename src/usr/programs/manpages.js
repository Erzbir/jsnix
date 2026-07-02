/**
 * usr/programs/manpages.js - Manual page metadata and rendering helpers
 *
 * Built-in programs may pass a `man` value to register_binary(). During boot,
 * rootfs publishes that manual into /usr/share/man. Programs without explicit
 * metadata receive a small generated page so `man` always reads a real file.
 */

'use strict';

const DEFAULT_MANUALS = Object.freeze({
    awk: ['pattern scanning and processing language', 'awk [-F sep] program [file...]'],
    apropos: ['search manual page names and descriptions', 'apropos keyword...'],
    cat: ['concatenate files and print on standard output', 'cat [-n] [file...]'],
    chmod: ['change file mode bits', 'chmod [-R] mode file...'],
    chown: ['change file owner and group', 'chown [-R] owner[:group] file...'],
    clear: ['clear the terminal screen', 'clear'],
    cp: ['copy files and directories', 'cp source destination'],
    curl: ['transfer a URL', 'curl [-I] [-o file] URL'],
    date: ['print the system date and time', 'date'],
    df: ['report file system disk space usage', 'df'],
    diff: ['compare files line by line', 'diff file1 file2'],
    echo: ['display a line of text', 'echo [string...]'],
    env: ['print the environment', 'env'],
    find: ['search for files in a directory hierarchy', 'find [path] [-name pattern]'],
    grep: ['print lines that match patterns', 'grep [-inv] pattern [file...]'],
    head: ['output the first part of files', 'head [-n count] [file...]'],
    hostname: ['show or set the system host name', 'hostname [name]'],
    id: ['print user and group IDs', 'id [user]'],
    ip: ['show network configuration', 'ip addr|link|route'],
    ln: ['link creation between files', 'ln [-s] target link_name'],
    ls: ['list directory contents', 'ls [-la] [file...]'],
    man: ['display system manual pages', 'man [section] page'],
    mkdir: ['make directories', 'mkdir directory...'],
    mv: ['move or rename files', 'mv source destination'],
    passwd: ['change a user password', 'passwd [user] [password]'],
    ping: ['send ICMP echo requests', 'ping [-c count] host'],
    ps: ['report process status', 'ps [aux]'],
    pwd: ['print name of current working directory', 'pwd'],
    reboot: ['restart the simulated system', 'reboot'],
    rm: ['remove files or directories', 'rm [-r] file...'],
    sed: ['stream editor for filtering and transforming text', 'sed [-n] script [file...]'],
    shutdown: ['halt, power off, or reboot the simulated system', 'shutdown [-h|-r] now'],
    stat: ['display file status', 'stat file...'],
    stty: ['show or change terminal line settings', 'stty [-a] [raw|sane|echo|-echo|icanon|-icanon]'],
    su: ['run a shell as another user', 'su [-l] [user] [-c command]'],
    sudo: ['execute a command as another user', 'sudo command [args...]'],
    tail: ['output the last part of files', 'tail [-n count] [file...]'],
    test: ['evaluate a conditional expression', 'test expression'],
    touch: ['change file timestamps or create files', 'touch file...'],
    tty: ['print the file name of the terminal connected to standard input', 'tty'],
    uname: ['print system information', 'uname [-a]'],
    useradd: ['create a new user', 'useradd [options] name'],
    wget: ['non-interactive network downloader', 'wget [-O file] URL'],
    whereis: ['locate binary and manual files', 'whereis name...'],
    which: ['locate a command', 'which command...'],
    whoami: ['print effective user name', 'whoami'],
    xargs: ['build and execute command lines from input', 'xargs [-n count] [command [args...]]'],
    xxd: ['make a hex dump', 'xxd [-p] [-l len] [-s seek] [-c cols] [-g group] [file...]'],
});

function normalize_lines(value) {
    if (Array.isArray(value)) return value.map(line => String(line));
    return String(value ?? '').split('\n');
}

export function render_manual_page(name, manual = null) {
    if (typeof manual === 'string')
        return manual.endsWith('\n') ? manual : `${manual}\n`;

    const fallback = DEFAULT_MANUALS[name] ?? [
        'JSNix user-space command',
        `${name} [arguments]`,
    ];
    const data = Array.isArray(manual)
        ? {description: manual[0], synopsis: manual[1]}
        : manual ?? {};
    const description = data.description ?? fallback[0];
    const synopsis = data.synopsis ?? fallback[1];
    const body = data.body ?? [
        'This program is installed as an executable file in the JSNix virtual',
        'file system. The shell starts it through the same exec path used for',
        'other simulated programs.',
    ];

    const lines = [
        `${name.toUpperCase()}(1)`,
        '',
        'NAME',
        `    ${name} - ${description}`,
        '',
        'SYNOPSIS',
        `    ${synopsis}`,
        '',
        'DESCRIPTION',
        ...normalize_lines(body).map(line => line ? `    ${line}` : ''),
    ];

    if (data.options) {
        lines.push('', 'OPTIONS');
        for (const line of normalize_lines(data.options))
            lines.push(line ? `    ${line}` : '');
    }

    return `${lines.join('\n')}\n`;
}

export function manpage_path(name, section = '1') {
    return `/usr/share/man/man${section}/${name}.${section}`;
}

export function manual_summary(name, content) {
    const lines = String(content ?? '').split('\n');
    const name_index = lines.findIndex(line => line.trim() === 'NAME');
    if (name_index < 0) return `${name} (1) - manual page`;
    const entry = lines.slice(name_index + 1)
        .find(line => line.trim());
    if (!entry) return `${name} (1) - manual page`;
    const summary = entry.trim().replace(/^([^ ]+)\s+-\s+/, '');
    return `${name} (1) - ${summary}`;
}
