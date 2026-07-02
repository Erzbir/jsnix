/**
 * kernel/tty/termios.js - Minimal task-local TTY state
 *
 * This is intentionally a small compatibility surface, not a full pty/termios
 * implementation. It gives processes stable Linux-like knobs for isatty,
 * tcgetattr/tcsetattr, and window-size ioctls.
 */

'use strict';

import {
    ECHO,
    ICANON,
    ISIG,
} from '../include/types.js';

export function create_default_termios() {
    return {
        iflag: 0,
        oflag: 0,
        cflag: 0,
        lflag: ISIG | ICANON | ECHO,
        cc: {
            VINTR: '\x03',
            VEOF: '\x04',
            VSUSP: '\x1a',
        },
        ispeed: 38400,
        ospeed: 38400,
    };
}

export function create_default_winsize() {
    return {
        rows: 24,
        cols: 80,
        xpixel: 0,
        ypixel: 0,
    };
}

export function create_tty_state(options = {}) {
    return {
        name: options.name ?? '/dev/pts/0',
        termios: normalize_termios(options.termios),
        winsize: normalize_winsize(options.winsize),
        foreground_pgid: Number(options.foreground_pgid ?? 0),
    };
}

export function clone_termios(termios = create_default_termios()) {
    return {
        iflag: Number(termios.iflag ?? 0),
        oflag: Number(termios.oflag ?? 0),
        cflag: Number(termios.cflag ?? 0),
        lflag: Number(termios.lflag ?? (ISIG | ICANON | ECHO)),
        cc: {...(termios.cc ?? {})},
        ispeed: Number(termios.ispeed ?? 38400),
        ospeed: Number(termios.ospeed ?? 38400),
    };
}

export function normalize_termios(termios = {}) {
    return clone_termios({
        ...create_default_termios(),
        ...(termios ?? {}),
        cc: {
            ...create_default_termios().cc,
            ...(termios?.cc ?? {}),
        },
    });
}

export function clone_winsize(winsize = create_default_winsize()) {
    return {
        rows: Number(winsize.rows ?? 24),
        cols: Number(winsize.cols ?? 80),
        xpixel: Number(winsize.xpixel ?? 0),
        ypixel: Number(winsize.ypixel ?? 0),
    };
}

export function normalize_winsize(winsize = {}) {
    const next = clone_winsize({
        ...create_default_winsize(),
        ...(winsize ?? {}),
    });
    next.rows = Math.max(0, Math.floor(next.rows));
    next.cols = Math.max(0, Math.floor(next.cols));
    next.xpixel = Math.max(0, Math.floor(next.xpixel));
    next.ypixel = Math.max(0, Math.floor(next.ypixel));
    return next;
}

export function is_tty_device_name(name) {
    return ['tty', 'console', 'ptmx', 'pts0'].includes(name);
}

export function is_tty_path(path) {
    return [
        '/dev/tty',
        '/dev/console',
        '/dev/ptmx',
        '/dev/pts/0',
        '/dev/stdin',
        '/dev/stdout',
        '/dev/stderr',
    ].includes(path);
}
