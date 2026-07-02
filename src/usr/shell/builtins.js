/**
 * usr/shell/builtins.js - GNU Bash builtin metadata
 */

'use strict';

export const SHELL_RESERVED_WORDS = Object.freeze([
    '!',
    '[[',
    ']]',
    '{',
    '}',
    'case',
    'coproc',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'function',
    'if',
    'in',
    'select',
    'then',
    'time',
    'until',
    'while',
]);

export const SHELL_SPECIAL_BUILTINS = Object.freeze([
    ':',
    '.',
    'break',
    'continue',
    'eval',
    'exec',
    'exit',
    'export',
    'readonly',
    'return',
    'set',
    'shift',
    'source',
    'times',
    'trap',
    'unset',
]);

export const SHELL_BUILTIN_HELP = Object.freeze({
    ':': ': [arguments] - expand arguments and return success',
    '.': '. file [args...] - execute commands from a file in this shell',
    '[': '[ expression ] - evaluate a conditional expression',
    alias: 'alias [name[=value] ...] - define or display aliases',
    bg: 'bg [job ...] - resume jobs in the background',
    bind: 'bind [options] [keyseq:function] - manage readline bindings',
    break: 'break [n] - exit from a loop',
    builtin: 'builtin command [args...] - execute a shell builtin',
    caller: 'caller [expr] - return shell function call context',
    cd: 'cd [dir] - change the current directory',
    command: 'command [-pVv] command [args...] - execute a command bypassing functions',
    compgen: 'compgen [option] [word] - generate completion matches',
    complete: 'complete [options] name ... - define programmable completion',
    compopt: 'compopt [options] [name] - modify completion options',
    continue: 'continue [n] - resume the next loop iteration',
    declare: 'declare [options] [name[=value] ...] - set variable attributes',
    dirs: 'dirs [options] - display the directory stack',
    disown: 'disown [options] [job ...] - remove jobs from the job table',
    echo: 'echo [-n] [arg ...] - display arguments',
    enable: 'enable [options] [name ...] - enable or disable shell builtins',
    eval: 'eval [arguments] - read arguments as a shell command',
    exec: 'exec command [args...] - replace the shell with command',
    exit: 'exit [status] - exit the shell',
    export: 'export NAME[=value] ... - mark names for export',
    false: 'false - return an unsuccessful status',
    fc: 'fc [options] [first [last]] - list or edit command history',
    fg: 'fg [job] - resume a job in the foreground',
    getopts: 'getopts optstring name [args...] - parse shell options',
    hash: 'hash [options] [name ...] - remember command pathnames',
    help: 'help [topic] - display bash builtin help',
    history: 'history [options] - display or manipulate command history',
    jobs: 'jobs [options] [job ...] - list active jobs',
    kill: 'kill [options] pid|jobspec ... - send a signal',
    let: 'let expression ... - evaluate arithmetic expressions',
    local: 'local [name[=value] ...] - declare local function variables',
    logout: 'logout - exit a login shell',
    mapfile: 'mapfile [options] [array] - read lines into an array',
    popd: 'popd [options] - remove a directory from the stack',
    printf: 'printf format [arg ...] - format and display data',
    pushd: 'pushd [options] [dir] - add a directory to the stack',
    pwd: 'pwd [-LP] - print the current working directory',
    read: 'read [name ...] - read one line from standard input',
    readarray: 'readarray [options] [array] - read lines into an array',
    readonly: 'readonly [name[=value] ...] - mark variables readonly',
    return: 'return [status] - return from a function or sourced script',
    set: 'set [options] [args...] - set shell options and positional parameters',
    shift: 'shift [n] - shift positional parameters',
    shopt: 'shopt [options] [optname ...] - set or unset shell options',
    source: 'source file [args...] - execute commands from a file in this shell',
    suspend: 'suspend [-f] - suspend this shell',
    test: 'test expression - evaluate a conditional expression',
    times: 'times - display shell and child process times',
    trap: 'trap [action] [signal ...] - handle shell signals',
    true: 'true - return a successful status',
    type: 'type [-aftpP] name ... - describe command resolution',
    typeset: 'typeset [options] [name[=value] ...] - synonym for declare',
    ulimit: 'ulimit [options] [limit] - get or set resource limits',
    umask: 'umask [mode] - display or set the file mode creation mask',
    unalias: 'unalias name ... - remove aliases',
    unset: 'unset NAME ... - remove variables or functions',
    wait: 'wait [id ...] - wait for jobs or child processes',
});

export const SHELL_BUILTINS = Object.freeze(Object.keys(SHELL_BUILTIN_HELP));

export function is_shell_builtin(name) {
    return Object.hasOwn(SHELL_BUILTIN_HELP, name);
}

export function is_shell_reserved_word(name) {
    return SHELL_RESERVED_WORDS.includes(name);
}
