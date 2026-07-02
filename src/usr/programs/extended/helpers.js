/**
 * usr/programs/extended/helpers.js - Shared extended-program helpers
 */

'use strict';

export const VIRTUAL_INTERFACES = [
    {
        name: 'lo',
        index: 1,
        flags: 'LOOPBACK,UP,LOWER_UP',
        address: '127.0.0.1/8',
        mac: '00:00:00:00:00:00',
    },
    {
        name: 'eth0',
        index: 2,
        flags: 'BROADCAST,MULTICAST,UP,LOWER_UP',
        address: '10.0.2.15/24',
        mac: '02:00:00:00:00:01',
    },
];

export const VIRTUAL_ROUTES = [
    'default via 10.0.2.2 dev eth0',
    '10.0.2.0/24 dev eth0 proto kernel scope link src 10.0.2.15',
];

export const SYSCTL = {
    'kernel.hostname': 'jsnix',
    'kernel.osrelease': '0.1.0-jsnix',
    'kernel.ostype': 'JSNix',
    'kernel.pid_max': '32768',
    'vm.swappiness': '60',
    'net.ipv4.ip_forward': '0',
    'net.ipv4.tcp_syncookies': '1',
};

export const loaded_modules = new Set(['jsfs', 'proc', 'tty']);

let temporary_counter = 0;

const DEFAULT_SYSCTL = Object.freeze({...SYSCTL});
const DEFAULT_LOADED_MODULES = Object.freeze(['jsfs', 'proc', 'tty']);

export function reset_extended_state() {
    for (const key of Object.keys(SYSCTL)) delete SYSCTL[key];
    Object.assign(SYSCTL, DEFAULT_SYSCTL);
    loaded_modules.clear();
    for (const name of DEFAULT_LOADED_MODULES) loaded_modules.add(name);
    temporary_counter = 0;
}

export function next_temporary_suffix() {
    return String(++temporary_counter).padStart(6, '0');
}

export function emit_text(ctx, content) {
    const lines = String(content).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) ctx.printf(line);
}

export function read_inputs(ctx, files) {
    if (!files.length) return ctx.stdin;
    return files.map(file =>
        file === '-' ? ctx.stdin : ctx.read(ctx.realpath(file))).join('');
}

export function forward_result(ctx, result) {
    if (!result) return 127;
    ctx.stdout_buf.push(...result.stdout_buf);
    ctx.stderr_buf.push(...result.stderr_buf);
    return result.exit_code;
}

export function parse_count(args, default_value = 4) {
    const index = args.indexOf('-c');
    if (index < 0) return default_value;
    const count = Number(args[index + 1]);
    return Number.isInteger(count) && count > 0 ? count : default_value;
}

export function escape_regex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function encode_base64(value) {
    const bytes = new TextEncoder().encode(value);
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index];
        const b = bytes[index + 1];
        const c = bytes[index + 2];
        const block = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
        output += alphabet[(block >> 18) & 63];
        output += alphabet[(block >> 12) & 63];
        output += b === undefined ? '=' : alphabet[(block >> 6) & 63];
        output += c === undefined ? '=' : alphabet[block & 63];
    }
    return output;
}

export function decode_base64(value) {
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0)
        throw new Error('invalid input');
    const bytes = [];
    for (let index = 0; index < clean.length; index += 4) {
        const chars = clean.slice(index, index + 4);
        const values = [...chars].map(char => char === '=' ? 0 : alphabet.indexOf(char));
        const block =
            (values[0] << 18) | (values[1] << 12) |
            (values[2] << 6) | values[3];
        bytes.push((block >> 16) & 255);
        if (chars[2] !== '=') bytes.push((block >> 8) & 255);
        if (chars[3] !== '=') bytes.push(block & 255);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

export function crc32(value) {
    const bytes = new TextEncoder().encode(value);
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function virtual_http(url) {
    if (url === 'http://localhost' || url === 'http://jsnix.local') {
        return {
            status: '200 OK',
            type: 'text/plain',
            body: 'JSNix virtual HTTP service\n',
        };
    }
    if (url === 'https://example.com' || url === 'http://example.com') {
        return {
            status: '200 OK',
            type: 'text/html',
            body: '<!doctype html><title>Example Domain</title><h1>Example Domain</h1>\n',
        };
    }
    return null;
}

function header_map(xhr) {
    const headers = {};
    const raw = xhr.getAllResponseHeaders?.() ?? '';
    for (const line of raw.trim().split(/[\r\n]+/)) {
        if (!line) continue;
        const index = line.indexOf(':');
        if (index < 0) continue;
        headers[line.slice(0, index).toLowerCase()] =
            line.slice(index + 1).trim();
    }
    return headers;
}

function browser_http(ctx, url, options = {}) {
    if (typeof XMLHttpRequest !== 'function') return null;

    const started = Date.now();
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? 'GET', url, false);
    xhr.setRequestHeader('Accept', options.accept ?? '*/*');
    try {
        xhr.send(null);
    } catch (error) {
        throw new Error(
            error.message ||
            'network request failed; browser CORS policy may apply',
        );
    }

    if (xhr.status === 0)
        throw new Error('network request failed');

    const headers = header_map(xhr);
    return {
        status: `${xhr.status} ${xhr.statusText || ''}`.trim(),
        status_code: xhr.status,
        type: headers['content-type'] ?? 'application/octet-stream',
        body: xhr.responseText ?? '',
        headers,
        elapsed_ms: Math.max(1, Date.now() - started),
        url,
    };
}

export function http_request(ctx, url, options = {}) {
    const virtual = virtual_http(url);
    if (virtual) return {
        ...virtual,
        status_code: Number(String(virtual.status).split(/\s+/)[0]) || 200,
        headers: {'content-type': virtual.type},
        elapsed_ms: 1,
        url,
        virtual: true,
    };

    return browser_http(ctx, url, options);
}
