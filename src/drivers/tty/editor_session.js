/**
 * drivers/tty/editor_session.js - Minimal vi-style foreground editor
 *
 * This is TTY-side state for the foreground application launched by
 * /usr/bin/vi or /usr/bin/vim. It models a small vi workalike: normal,
 * insert, and ex command modes.
 */

'use strict';

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 80;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function split_lines(content) {
    const lines = String(content ?? '').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines.length ? lines : [''];
}

function join_lines(lines) {
    return lines.join('\n') + '\n';
}

export class tty_editor_session {
    constructor(options = {}) {
        this.editor = options.editor ?? 'vim';
        this.path = options.path ?? null;
        this.readonly = Boolean(options.readonly);
        this.rows = options.rows ?? DEFAULT_ROWS;
        this.cols = options.cols ?? DEFAULT_COLS;
        this.lines = split_lines(options.content ?? '');
        this.row = 0;
        this.col = 0;
        this.top = 0;
        this.mode = 'normal';
        this.command = '';
        this.command_kind = ':';
        this.pending = '';
        this.yank = null;
        this.dirty = false;
        this.message = this.path
            ? `"${this.path}" ${this.lines.length}L`
            : '[No Name]';
        this.undo_stack = [];
    }

    get content() {
        return join_lines(this.lines);
    }

    _snapshot() {
        this.undo_stack.push({
            lines: this.lines.map(line => String(line)),
            row: this.row,
            col: this.col,
            dirty: this.dirty,
        });
        if (this.undo_stack.length > 100) this.undo_stack.shift();
    }

    _restore() {
        const state = this.undo_stack.pop();
        if (!state) {
            this.message = 'Already at oldest change';
            return;
        }
        this.lines = state.lines;
        this.row = state.row;
        this.col = state.col;
        this.dirty = true;
        this.message = '1 change undone';
        this._normalize_cursor();
    }

    _mark_changed() {
        this.dirty = true;
        this.message = '';
    }

    _line() {
        return this.lines[this.row] ?? '';
    }

    _set_line(value) {
        this.lines[this.row] = value;
    }

    _normalize_cursor() {
        this.row = clamp(this.row, 0, Math.max(0, this.lines.length - 1));
        this.col = clamp(this.col, 0, this._line().length);
        const visible_rows = this.rows - 1;
        if (this.row < this.top) this.top = this.row;
        if (this.row >= this.top + visible_rows)
            this.top = this.row - visible_rows + 1;
        this.top = Math.max(0, this.top);
    }

    _move(delta_row, delta_col = 0) {
        this.row += delta_row;
        this.col += delta_col;
        this._normalize_cursor();
    }

    _insert_text(text) {
        this._snapshot();
        const line = this._line();
        this._set_line(line.slice(0, this.col) + text + line.slice(this.col));
        this.col += text.length;
        this._mark_changed();
    }

    _backspace() {
        if (this.col === 0 && this.row === 0) return;
        this._snapshot();
        if (this.col > 0) {
            const line = this._line();
            this._set_line(line.slice(0, this.col - 1) + line.slice(this.col));
            this.col--;
        } else {
            const previous = this.lines[this.row - 1];
            const current = this._line();
            this.col = previous.length;
            this.lines.splice(this.row - 1, 2, previous + current);
            this.row--;
        }
        this._mark_changed();
        this._normalize_cursor();
    }

    _newline() {
        this._snapshot();
        const line = this._line();
        this.lines.splice(this.row, 1, line.slice(0, this.col), line.slice(this.col));
        this.row++;
        this.col = 0;
        this._mark_changed();
        this._normalize_cursor();
    }

    _delete_char() {
        const line = this._line();
        if (!line.length) return;
        this._snapshot();
        this._set_line(line.slice(0, this.col) + line.slice(this.col + 1));
        this._mark_changed();
        this._normalize_cursor();
    }

    _delete_line() {
        this._snapshot();
        this.yank = this._line();
        if (this.lines.length === 1) {
            this.lines[0] = '';
            this.row = 0;
            this.col = 0;
        } else {
            this.lines.splice(this.row, 1);
        }
        this._mark_changed();
        this._normalize_cursor();
    }

    _paste() {
        if (this.yank === null) return;
        this._snapshot();
        this.lines.splice(this.row + 1, 0, this.yank);
        this.row++;
        this.col = 0;
        this._mark_changed();
        this._normalize_cursor();
    }

    _open_below() {
        this._snapshot();
        this.lines.splice(this.row + 1, 0, '');
        this.row++;
        this.col = 0;
        this.mode = 'insert';
        this._mark_changed();
        this._normalize_cursor();
    }

    _search(pattern) {
        if (!pattern) return;
        for (let offset = 1; offset <= this.lines.length; offset++) {
            const row = (this.row + offset) % this.lines.length;
            const col = this.lines[row].indexOf(pattern);
            if (col >= 0) {
                this.row = row;
                this.col = col;
                this.message = `/${pattern}`;
                this._normalize_cursor();
                return;
            }
        }
        this.message = `Pattern not found: ${pattern}`;
    }

    _run_ex_command() {
        const raw = this.command.trim();
        this.command = '';
        this.mode = 'normal';
        if (!raw) return {};

        const [cmd, ...rest] = raw.split(/\s+/);
        const path = rest.join(' ') || this.path;
        if (cmd === 'q') {
            if (this.dirty) {
                this.message = 'No write since last change (add ! to override)';
                return {};
            }
            return {exit: true};
        }
        if (cmd === 'q!') return {exit: true};
        if (cmd === 'w' || cmd === 'write') {
            if (!path) {
                this.message = 'No file name';
                return {};
            }
            return {write: {path, content: this.content}};
        }
        if (cmd === 'wq' || cmd === 'x') {
            if (!path) {
                this.message = 'No file name';
                return {};
            }
            return {
                write: {path, content: this.content},
                exit_after_write: true,
            };
        }
        this.message = `Not an editor command: ${raw}`;
        return {};
    }

    apply_write(path) {
        this.path = path;
        this.dirty = false;
        this.message = `"${path}" ${this.lines.length}L written`;
    }

    apply_write_error(path, message) {
        this.message = `"${path}" ${message}`;
    }

    handle_key(key) {
        this.message = '';
        if (this.mode === 'insert') return this._handle_insert_key(key);
        if (this.mode === 'command') return this._handle_command_key(key);
        return this._handle_normal_key(key);
    }

    _handle_insert_key(key) {
        if (key === 'Escape') {
            this.mode = 'normal';
            this._normalize_cursor();
            return {};
        }
        if (key === 'Backspace') {
            this._backspace();
            return {};
        }
        if (key === 'Enter') {
            this._newline();
            return {};
        }
        if (key === 'ArrowLeft') this._move(0, -1);
        else if (key === 'ArrowRight') this._move(0, 1);
        else if (key === 'ArrowUp') this._move(-1);
        else if (key === 'ArrowDown') this._move(1);
        else if (key.length === 1) this._insert_text(key);
        return {};
    }

    _handle_command_key(key) {
        if (key === 'Escape') {
            this.command = '';
            this.mode = 'normal';
            return {};
        }
        if (key === 'Backspace') {
            this.command = this.command.slice(0, -1);
            return {};
        }
        if (key === 'Enter') {
            if (this.command_kind === '/') {
                const pattern = this.command;
                this.command = '';
                this.mode = 'normal';
                this._search(pattern);
                return {};
            }
            return this._run_ex_command();
        }
        if (key.length === 1) this.command += key;
        return {};
    }

    _handle_normal_key(key) {
        if (key === 'ArrowLeft' || key === 'h') this._move(0, -1);
        else if (key === 'ArrowRight' || key === 'l') this._move(0, 1);
        else if (key === 'ArrowUp' || key === 'k') this._move(-1);
        else if (key === 'ArrowDown' || key === 'j') this._move(1);
        else if (key === '0') {
            this.col = 0;
            this._normalize_cursor();
        } else if (key === '$') {
            this.col = this._line().length;
            this._normalize_cursor();
        } else if (key === 'i') {
            this.mode = 'insert';
        } else if (key === 'a') {
            this.col = Math.min(this._line().length, this.col + 1);
            this.mode = 'insert';
        } else if (key === 'o') {
            this._open_below();
        } else if (key === 'x') {
            this._delete_char();
        } else if (key === 'p') {
            this._paste();
        } else if (key === 'u') {
            this._restore();
        } else if (key === 'y' && this.pending === 'y') {
            this.yank = this._line();
            this.pending = '';
            this.message = '1 line yanked';
        } else if (key === 'd' && this.pending === 'd') {
            this.pending = '';
            this._delete_line();
        } else if (key === 'd' || key === 'y') {
            this.pending = key;
        } else if (key === ':') {
            this.mode = 'command';
            this.command_kind = ':';
            this.command = '';
        } else if (key === '/') {
            this.mode = 'command';
            this.command_kind = '/';
            this.command = '';
        } else {
            this.pending = '';
        }
        return {};
    }

    screen() {
        this._normalize_cursor();
        const visible_rows = this.rows - 1;
        const body = [];
        for (let index = 0; index < visible_rows; index++) {
            const line_index = this.top + index;
            const text = line_index < this.lines.length
                ? this.lines[line_index]
                : '~';
            body.push({
                number: line_index < this.lines.length ? line_index + 1 : null,
                text: text.slice(0, this.cols),
                cursor:
                    line_index === this.row && this.mode !== 'command'
                        ? this.col
                        : null,
            });
        }
        const mode_label = this.mode === 'insert'
            ? '-- INSERT --'
            : this.mode === 'command'
                ? `${this.command_kind}${this.command}`
                : this.message;
        const name = this.path ?? '[No Name]';
        return {
            type: 'editor-screen',
            editor: this.editor,
            path: this.path,
            dirty: this.dirty,
            mode: this.mode,
            rows: body,
            status: `"${name}"${this.dirty ? ' [+]' : ''} ` +
                `${this.row + 1},${this.col + 1} ${mode_label}`,
        };
    }
}
