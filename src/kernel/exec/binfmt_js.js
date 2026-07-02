/**
 * kernel/exec/binfmt_js.js - JavaScript executable image format
 *
 * This module recognizes JSNix executable images and compiles JavaScript entry
 * points. Script dispatch lives in execve.js, mirroring fs/binfmt_script.c.
 */

'use strict';

import {ENOEXEC} from '../include/types.js';

export const JSNIX_EXEC_MAGIC = '\x7fELFJSNIX';

const JSNIX_EXEC_VERSION = 1;
const JSNIX_EXEC_ABI_JS = 1;
const JSNIX_EXEC_KIND_ENTRY = 1;
const JSNIX_EXEC_KIND_AUTO = 2;
const JSNIX_EXEC_FLAGS_NONE = 0;
const JSNIX_EXEC_HEADER_SIZE = JSNIX_EXEC_MAGIC.length + 8;

function exec_format_error() {
    return Object.assign(new Error('Exec format error'), {errno: ENOEXEC});
}

function compact_source(source) {
    const output = [];
    let quote = null;
    let escaped = false;
    let pending_space = false;

    const emit_space = () => {
        if (output.length) pending_space = true;
    };
    const emit = char => {
        if (pending_space && output.length) output.push(' ');
        pending_space = false;
        output.push(char);
    };

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];

        if (quote) {
            output.push(char);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index + 1 < source.length && source[index + 1] !== '\n')
                index++;
            emit_space();
            continue;
        }
        if (char === '/' && next === '*') {
            index += 2;
            while (index < source.length &&
                !(source[index] === '*' && source[index + 1] === '/'))
                index++;
            if (index < source.length) index++;
            emit_space();
            continue;
        }
        if (/\s/.test(char)) {
            emit_space();
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            emit(char);
            quote = char;
            escaped = false;
            continue;
        }

        emit(char);
    }

    return output.join('').trim();
}

export function normalize_program_source(program) {
    const source = typeof program === 'function'
        ? program.toString()
        : String(program);
    return compact_source(source.trim());
}

function byte(value) {
    return String.fromCharCode(value & 0xff);
}

function u32le(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
        throw exec_format_error();
    return byte(value) +
        byte(value >>> 8) +
        byte(value >>> 16) +
        byte(value >>> 24);
}

function byte_at(text, offset) {
    const value = text.charCodeAt(offset);
    if (!Number.isInteger(value)) throw exec_format_error();
    return value & 0xff;
}

function u32le_at(text, offset) {
    return (
        byte_at(text, offset) |
        (byte_at(text, offset + 1) << 8) |
        (byte_at(text, offset + 2) << 16) |
        (byte_at(text, offset + 3) << 24)
    ) >>> 0;
}

function kind_code(kind) {
    if (kind === 'entry') return JSNIX_EXEC_KIND_ENTRY;
    if (kind === 'auto') return JSNIX_EXEC_KIND_AUTO;
    throw exec_format_error();
}

function kind_name(code) {
    if (code === JSNIX_EXEC_KIND_ENTRY) return 'entry';
    if (code === JSNIX_EXEC_KIND_AUTO) return 'auto';
    throw exec_format_error();
}

export function create_program_image(program) {
    const source = normalize_program_source(program);
    const kind = typeof program === 'function' ? 'entry' : 'auto';
    return JSNIX_EXEC_MAGIC +
        byte(JSNIX_EXEC_VERSION) +
        byte(JSNIX_EXEC_ABI_JS) +
        byte(kind_code(kind)) +
        byte(JSNIX_EXEC_FLAGS_NONE) +
        u32le(source.length) +
        source;
}

function default_header() {
    return {
        format: 'jsnix-js',
        version: 1,
        kind: 'auto',
    };
}

function parse_optional_header(body) {
    const first_line_end = body.indexOf('\n');
    const first_line = (first_line_end < 0 ? body : body.slice(0, first_line_end)).trim();
    if (!first_line.startsWith('{') || !first_line.endsWith('}'))
        return {header: default_header(), source: body};

    let header;
    try {
        header = JSON.parse(first_line);
    } catch {
        return {header: default_header(), source: body};
    }
    if (header.format !== 'jsnix-js' || header.version !== 1)
        throw exec_format_error();

    const source = first_line_end < 0 ? '' : body.slice(first_line_end + 1);
    return {header, source};
}

export function parse_program_image(content) {
    const text = String(content ?? '');
    if (!text.startsWith(JSNIX_EXEC_MAGIC) ||
        text.length < JSNIX_EXEC_HEADER_SIZE)
        throw exec_format_error();

    const version = byte_at(text, JSNIX_EXEC_MAGIC.length);
    const abi = byte_at(text, JSNIX_EXEC_MAGIC.length + 1);
    const kind = kind_name(byte_at(text, JSNIX_EXEC_MAGIC.length + 2));
    const flags = byte_at(text, JSNIX_EXEC_MAGIC.length + 3);
    const source_length = u32le_at(text, JSNIX_EXEC_MAGIC.length + 4);
    const source_start = JSNIX_EXEC_HEADER_SIZE;
    const source_end = source_start + source_length;
    if (version !== JSNIX_EXEC_VERSION ||
        abi !== JSNIX_EXEC_ABI_JS ||
        flags !== JSNIX_EXEC_FLAGS_NONE ||
        source_end !== text.length)
        throw exec_format_error();

    const header = {
        format: 'jsnix-exec',
        abi: 'jsnix-js',
        version,
        kind,
    };
    const source = text.slice(source_start, source_end).trim();
    if (!source) throw exec_format_error();
    return {type: 'exec', header, source, size: text.length};
}

export function parse_js_script_image(content) {
    const text = String(content ?? '');
    const first_newline = text.indexOf('\n');
    const body = text.startsWith('#!')
        ? first_newline < 0 ? '' : text.slice(first_newline + 1)
        : text;
    const parsed = parse_optional_header(body);
    const header = {
        ...parsed.header,
        format: 'jsnix-js',
    };
    const source = parsed.source.trim();
    if (!source) throw exec_format_error();
    return {type: 'script', header, source, size: text.length};
}

function matching_parenthesis(source) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let line_comment = false;
    let block_comment = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];
        if (line_comment) {
            if (char === '\n') line_comment = false;
            continue;
        }
        if (block_comment) {
            if (char === '*' && next === '/') {
                block_comment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === '/' && next === '/') {
            line_comment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            block_comment = true;
            index++;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '(') depth++;
        if (char === ')' && --depth === 0) return index;
    }
    return -1;
}

function is_function_source(source) {
    if (/^(?:async\s+)?function\b/.test(source) ||
        /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source))
        return true;
    if (!source.startsWith('(')) return false;

    const closing = matching_parenthesis(source);
    if (closing < 0) return false;
    const trailing = source.slice(closing + 1).trim();
    if (trailing && trailing !== ';') return false;
    return is_function_source(source.slice(1, closing).trim());
}

export function is_async_program_source(source) {
    source = String(source ?? '').trim();
    if (/^async\s+function\b/.test(source) ||
        /^async\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source))
        return true;
    if (!source.startsWith('(')) return false;

    const closing = matching_parenthesis(source);
    if (closing < 0) return false;
    const trailing = source.slice(closing + 1).trim();
    if (trailing && trailing !== ';') return false;
    return is_async_program_source(source.slice(1, closing).trim());
}

export function compile_program_image(image, registered_program = null) {
    if (registered_program?.source === image.source)
        return registered_program.fn;

    const source = image.source.trim();
    const kind = image.header.kind ?? 'entry';
    if (kind === 'auto' && !is_function_source(source)) {
        try {
            return Function('ctx', `"use strict";\n${source}\n`);
        } catch {
            throw exec_format_error();
        }
    }

    let entry;
    try {
        entry = Function(`"use strict"; return (${source});`)();
    } catch {
        throw exec_format_error();
    }
    if (typeof entry !== 'function') throw exec_format_error();
    return entry;
}
