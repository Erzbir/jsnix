/**
 * usr/shell/history.js - Shared shell command history
 */

'use strict';

export const bash_history = [];

export function reset_bash_history() {
    bash_history.length = 0;
}
