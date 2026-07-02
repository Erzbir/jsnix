/**
 * usr/shell/completion.js - Bash-style tab completion helpers
 */

'use strict';

import {INIT_PID} from '../../kernel/include/types.js';
import {ksyms} from '../../kernel/ksyms.js';
import {list_binaries} from '../../kernel/exec/execve.js';
import {SHELL_BUILTINS} from './builtins.js';

export function bash_tab_complete(shell, input) {
    const trailing_space = /\s$/.test(input);
    const tokens = input.match(/\S+/g) ?? [];
    const last = trailing_space ? '' : tokens.at(-1) ?? '';
    const is_cmd = tokens.length === 0 ||
        (tokens.length === 1 && !trailing_space);

    if (is_cmd) {
        return [...new Set([...list_binaries(shell?.pid), ...SHELL_BUILTINS])]
            .filter(n => n.startsWith(last))
            .sort();
    }

    const slash = last.lastIndexOf('/');
    const dir = slash >= 0 ? last.slice(0, slash) || '/' : '.';
    const prefix = slash >= 0 ? last.slice(slash + 1) : last;
    const abs = ksyms.path_resolve(dir, shell?.cwd ?? '/');
    const r = ksyms.syscall(shell?.pid ?? INIT_PID, ksyms.nr.__NR_getdents, abs);
    if (r.err) return [];
    return r.val
        .filter(n => n.startsWith(prefix))
        .map(n => slash >= 0 ? last.slice(0, slash + 1) + n : n);
}
