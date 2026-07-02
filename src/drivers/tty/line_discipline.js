/**
 * drivers/tty/line_discipline.js - N_TTY style line editing helpers
 *
 * These functions are independent of the DOM and can be used by any
 * renderer, including browser, canvas, React, Vue, and Node adapters.
 */

'use strict';

export function tty_replace_completion(value, cursor, completion) {
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const match = before.match(/\S*$/);
    const start = match?.index ?? cursor;
    const next = before.slice(0, start) + completion + after;
    return {
        value: next,
        cursor: start + completion.length,
    };
}

export function tty_move_history(history, state, direction, current_value) {
    const length = history.length;
    if (!length) return current_value;

    if (direction < 0) {
        if (state.hist_idx >= length) {
            state.hist_idx = length;
            state.hist_draft = current_value;
        }
        if (state.hist_idx > 0) state.hist_idx--;
        return history[state.hist_idx] ?? current_value;
    }

    if (state.hist_idx < length - 1) {
        state.hist_idx++;
        return history[state.hist_idx] ?? '';
    }
    state.hist_idx = length;
    return state.hist_draft ?? '';
}
