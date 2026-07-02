/**
 * kernel/exec/program_registry.js - Built-in program compatibility registry
 *
 * The executable file remains authoritative. This registry only preserves
 * module closures for built-in programs when their path and source still
 * match the published file.
 */

'use strict';

import {
    create_program_image,
    normalize_program_source,
} from './binfmt_js.js';

const entries_by_name = new Map();
const programs_by_path = new Map();
const programs_by_source = new Map();
let publisher = null;

export function reset_binary_publisher() {
    publisher = null;
}

const SYSTEM_PROGRAMS = new Set([
    'blkid',
    'groupadd',
    'groupdel',
    'groupmod',
    'ifconfig',
    'ip',
    'lsmod',
    'modprobe',
    'reboot',
    'route',
    'shutdown',
    'sysctl',
    'useradd',
    'userdel',
    'usermod',
]);

function default_program_path(name) {
    const directory = SYSTEM_PROGRAMS.has(name)
        ? '/usr/sbin'
        : '/usr/bin';
    return `${directory}/${name}`;
}

export function register_binary(
    name,
    program,
    path = default_program_path(name),
    options = {},
) {
    if (typeof program !== 'function')
        throw new TypeError('register_binary: program must be a function');

    const source = normalize_program_source(program);
    const entry = {
        name,
        path,
        source,
        image: create_program_image(program),
        man: options.man ?? null,
        mode: options.mode ?? 0o755,
        uid: options.uid ?? 0,
        gid: options.gid ?? 0,
    };
    const previous = entries_by_name.get(name);
    if (previous?.path && previous.path !== path)
        programs_by_path.delete(previous.path);

    entries_by_name.set(name, entry);
    programs_by_path.set(path, {fn: program, source});
    programs_by_source.set(source, {fn: program, source});
    if (publisher) publisher(entry);
    return entry;
}

export function find_registered_program(path, source) {
    return programs_by_path.get(path) ?? programs_by_source.get(source) ?? null;
}

export function list_registered_program_names() {
    return [...entries_by_name.keys()];
}

export function list_binary_entries() {
    return [...entries_by_name.values()].map(entry => ({...entry}));
}

export function get_registered_binary_path(name) {
    return entries_by_name.get(name)?.path ?? null;
}

export function set_binary_publisher(next_publisher) {
    publisher = next_publisher;
    for (const entry of list_binary_entries()) publisher(entry);
}
