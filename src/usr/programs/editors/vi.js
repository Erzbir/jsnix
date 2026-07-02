/**
 * usr/programs/editors/vi.js - Minimal vi/vim launcher
 */

'use strict';

import {register_binary} from '../../../kernel/exec/program_registry.js';

function open_editor(ctx, editor) {
    const args = ctx.args.filter(arg => !arg.startsWith('-'));
    const target = args[0] ?? null;
    let path = null;
    let content = '';

    if (target) {
        path = ctx.realpath(target);
        try {
            const stat = ctx.stat(path);
            if (stat.type !== 'file') {
                ctx.perror(`${editor}: ${target}: Is a directory`);
                return 1;
            }
            content = ctx.read(path);
        } catch (error) {
            if (error.errno !== 2) {
                ctx.perror(`${editor}: ${target}: ${error.message}`);
                return 1;
            }
            content = '';
        }
    }

    ctx.special('editor-session', {
        editor,
        path,
        content,
        readonly: ctx.args.includes('-R'),
    });
    return 0;
}

const manual = {
    description: 'screen-oriented text editor',
    synopsis: 'vi [file]',
    body: [
        'This is a small JSNix vi-compatible editor. It supports normal,',
        'insert, and ex command modes for basic file editing.',
        '',
        'Common keys: i, a, o, h, j, k, l, arrow keys, x, dd, yy, p, u,',
        ':w, :q, :wq, :q!, and /pattern.',
    ],
};

function vi(ctx) {
    return open_editor(ctx, 'vi');
}

function vim(ctx) {
    return open_editor(ctx, 'vim');
}

register_binary('vi', vi, '/usr/bin/vi', {man: manual});
register_binary('vim', vim, '/usr/bin/vim', {
    man: {
        ...manual,
        synopsis: 'vim [file]',
    },
});
