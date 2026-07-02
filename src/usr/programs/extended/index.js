/**
 * usr/programs/extended/index.js - Extended user-space program set
 *
 * The network commands use a deterministic virtual network. They do not
 * contact the host network because the command execution model is synchronous.
 */

'use strict';

import {SIGTERM} from '../../../kernel/include/types.js';
import {ksyms} from '../../../kernel/ksyms.js';
import {JSNIX_EXEC_MAGIC} from '../../../kernel/exec/binfmt_js.js';
import {register_binary} from '../../../kernel/exec/program_registry.js';
import {manual_summary} from '../manpages.js';
import {
    SYSCTL,
    VIRTUAL_INTERFACES,
    VIRTUAL_ROUTES,
    crc32,
    decode_base64,
    emit_text,
    encode_base64,
    escape_regex,
    forward_result,
    http_request,
    loaded_modules,
    next_temporary_suffix,
    parse_count,
    read_inputs,
} from './helpers.js';

function ln(ctx) {
    const symbolic = ctx.args.includes('-s');
    const force = ctx.args.includes('-f');
    const paths = ctx.args.filter(arg => !['-s', '-f'].includes(arg));
    if (paths.length !== 2) {
        ctx.perror('ln: usage: ln [-sf] TARGET LINK_NAME');
        return 1;
    }
    const [target, raw_destination] = paths;
    let destination = ctx.realpath(raw_destination);
    try {
        if (ctx.stat(destination).type === 'dir')
            destination += `/${target.split('/').pop()}`;
        else if (force)
            ctx.unlink(destination);
    } catch (error) {
        if (error.errno !== 2) {
            ctx.perror(`ln: ${error.message}`);
            return 1;
        }
    }
    try {
        if (symbolic) ctx.symlink(target, destination);
        else ctx.link(ctx.realpath(target), destination);
        return 0;
    } catch (error) {
        ctx.perror(`ln: failed to create link '${raw_destination}': ${error.message}`);
        return 1;
    }
}

function readlink(ctx) {
    const canonical = ctx.args.includes('-f');
    const path = ctx.args.find(arg => arg !== '-f');
    if (!path) {
        ctx.perror('readlink: missing operand');
        return 1;
    }
    try {
        ctx.printf(canonical
            ? ctx.canonicalize(path)
            : ctx.readlink(ctx.realpath(path)));
        return 0;
    } catch (error) {
        ctx.perror(`readlink: ${path}: ${error.message}`);
        return 1;
    }
}

function realpath(ctx) {
    if (!ctx.args.length) {
        ctx.perror('realpath: missing operand');
        return 1;
    }
    let status = 0;
    for (const path of ctx.args) {
        try {
            ctx.printf(ctx.canonicalize(path));
        } catch (error) {
            ctx.perror(`realpath: ${path}: ${error.message}`);
            status = 1;
        }
    }
    return status;
}

function file(ctx) {
    if (!ctx.args.length) {
        ctx.perror('file: missing operand');
        return 1;
    }
    for (const path of ctx.args) {
        try {
            const absolute = ctx.realpath(path);
            const stat = ctx.lstat(absolute);
            if (stat.type === 'dir') ctx.printf(`${path}: directory`);
            else if (stat.type === 'link')
                ctx.printf(`${path}: symbolic link to ${ctx.readlink(absolute)}`);
            else if (stat.type === 'char')
                ctx.printf(`${path}: character special`);
            else {
                const content = ctx.read(absolute);
                if (content.startsWith(JSNIX_EXEC_MAGIC)) {
                    ctx.printf(`${path}: JSNix executable image, ABI jsnix-js`);
                    continue;
                }
                if (content.startsWith('\x7fELF')) {
                    ctx.printf(`${path}: ELF executable data`);
                    continue;
                }
                if (content.startsWith('#!')) {
                    const line = content.split(/\r?\n/, 1)[0].slice(2).trim();
                    const interpreter = line.replace(/^\//, '');
                    if (/\bbash\b/.test(line))
                        ctx.printf(`${path}: Bourne-Again shell script, ASCII text executable`);
                    else
                        ctx.printf(`${path}: a ${interpreter} script text executable, ASCII text`);
                    continue;
                }
                const printable = [...content].every(char =>
                    char === '\n' || char === '\r' || char === '\t' ||
                    char.charCodeAt(0) >= 32);
                ctx.printf(`${path}: ${printable ? 'ASCII text' : 'data'}`);
            }
        } catch (error) {
            ctx.perror(`file: ${path}: ${error.message}`);
        }
    }
    return 0;
}

function mktemp(ctx) {
    const make_directory = ctx.args.includes('-d');
    const template = ctx.args.find(arg => !arg.startsWith('-')) ??
        '/tmp/tmp.XXXXXX';
    const suffix = next_temporary_suffix();
    const path = template.includes('XXXXXX')
        ? template.replace('XXXXXX', suffix)
        : `${template}.${suffix}`;
    try {
        if (make_directory) ctx.mkdir(ctx.realpath(path), 0o700);
        else ctx.write(ctx.realpath(path), '');
        ctx.printf(ctx.realpath(path));
        return 0;
    } catch (error) {
        ctx.perror(`mktemp: ${error.message}`);
        return 1;
    }
}

function sync() {
    return 0;
}

function reboot(ctx) {
    try {
        ctx.reboot('restart');
        ctx.printf('reboot: Restarting system');
        return 0;
    } catch (error) {
        ctx.perror(`reboot: ${error.message}`);
        return error.errno === 1 ? 1 : 2;
    }
}

function shutdown(ctx) {
    const reboot = ctx.args.includes('-r') || ctx.args.includes('--reboot');
    const halt = ctx.args.includes('-H') || ctx.args.includes('--halt');
    const poweroff = ctx.args.includes('-h') ||
        ctx.args.includes('-P') ||
        ctx.args.includes('--poweroff') ||
        ctx.args.length === 0 ||
        ctx.args.includes('now');
    const when = ctx.args.find(arg => !arg.startsWith('-')) ?? 'now';
    if (when !== 'now' && when !== '+0') {
        ctx.perror('shutdown: only immediate shutdown is supported');
        return 1;
    }

    const action = reboot ? 'restart' : halt ? 'halt' : poweroff ? 'poweroff' : 'poweroff';
    try {
        ctx.reboot(action);
        ctx.printf(action === 'restart'
            ? 'shutdown: Restarting system'
            : 'shutdown: Powering off');
        return 0;
    } catch (error) {
        ctx.perror(`shutdown: ${error.message}`);
        return error.errno === 1 ? 1 : 2;
    }
}

function tac(ctx) {
    try {
        let lines = read_inputs(ctx, ctx.args).split('\n');
        if (lines.at(-1) === '') lines.pop();
        lines.reverse().forEach(line => ctx.printf(line));
        return 0;
    } catch (error) {
        ctx.perror(`tac: ${error.message}`);
        return 1;
    }
}

function nl(ctx) {
    const files = ctx.args.filter(arg => !arg.startsWith('-'));
    try {
        const lines = read_inputs(ctx, files).split('\n');
        if (lines.at(-1) === '') lines.pop();
        lines.forEach((line, index) =>
            ctx.printf(`${String(index + 1).padStart(6)}\t${line}`));
        return 0;
    } catch (error) {
        ctx.perror(`nl: ${error.message}`);
        return 1;
    }
}

function rev(ctx) {
    try {
        const content = read_inputs(ctx, ctx.args);
        const lines = content.split('\n');
        if (lines.at(-1) === '') lines.pop();
        lines.forEach(line => ctx.printf([...line].reverse().join('')));
        return 0;
    } catch (error) {
        ctx.perror(`rev: ${error.message}`);
        return 1;
    }
}

function paste(ctx) {
    if (!ctx.args.length) {
        emit_text(ctx, ctx.stdin);
        return 0;
    }
    try {
        const columns = ctx.args.map(file =>
            ctx.read(ctx.realpath(file)).replace(/\n$/, '').split('\n'));
        const rows = Math.max(...columns.map(column => column.length));
        for (let row = 0; row < rows; row++)
            ctx.printf(columns.map(column => column[row] ?? '').join('\t'));
        return 0;
    } catch (error) {
        ctx.perror(`paste: ${error.message}`);
        return 1;
    }
}

function fold(ctx) {
    const width_index = ctx.args.indexOf('-w');
    const width = width_index >= 0 ? Number(ctx.args[width_index + 1]) : 80;
    const files = ctx.args.filter((arg, index) =>
        arg !== '-w' && index !== width_index + 1);
    if (!Number.isInteger(width) || width < 1) {
        ctx.perror('fold: invalid width');
        return 1;
    }
    try {
        for (const line of read_inputs(ctx, files).split('\n'))
            for (let index = 0; index < line.length; index += width)
                ctx.printf(line.slice(index, index + width));
        return 0;
    } catch (error) {
        ctx.perror(`fold: ${error.message}`);
        return 1;
    }
}

function sed(ctx) {
    const quiet = ctx.args.includes('-n');
    const args = ctx.args.filter(arg => arg !== '-n');
    const script = args.shift();
    if (!script) {
        ctx.perror('sed: missing script');
        return 1;
    }
    let content;
    try {
        content = read_inputs(ctx, args);
    } catch (error) {
        ctx.perror(`sed: ${error.message}`);
        return 1;
    }
    const substitution = script.match(/^s(.)(.*?)\1(.*?)\1([gp]*)$/);
    if (substitution) {
        const [, , pattern, replacement, flags] = substitution;
        let expression;
        try {
            expression = new RegExp(pattern, flags.includes('g') ? 'g' : '');
        } catch (error) {
            ctx.perror(`sed: ${error.message}`);
            return 1;
        }
        for (const line of content.replace(/\n$/, '').split('\n')) {
            const changed = expression.test(line);
            expression.lastIndex = 0;
            const output = line.replace(expression, replacement);
            if (!quiet || flags.includes('p') && changed) ctx.printf(output);
        }
        return 0;
    }
    if (script === 'p') {
        emit_text(ctx, content);
        return 0;
    }
    if (script === 'd') return 0;
    const line_print = script.match(/^(\d+)p$/);
    if (line_print) {
        const line = content.replace(/\n$/, '').split('\n')[Number(line_print[1]) - 1];
        if (line !== undefined) ctx.printf(line);
        return 0;
    }
    ctx.perror(`sed: unsupported script '${script}'`);
    return 1;
}

function awk(ctx) {
    const args = [...ctx.args];
    let separator = /\s+/;
    if (args[0] === '-F') separator = args.splice(0, 2)[1] ?? /\s+/;
    else if (args[0]?.startsWith('-F')) separator = args.shift().slice(2);
    const program = args.shift();
    if (!program) {
        ctx.perror('awk: missing program');
        return 1;
    }
    let content;
    try {
        content = read_inputs(ctx, args);
    } catch (error) {
        ctx.perror(`awk: ${error.message}`);
        return 1;
    }
    const match = program.match(
        /^(?:\/(.*)\/\s*)?\{\s*print\s+(.+?)\s*\}$/);
    if (!match) {
        ctx.perror('awk: supported form: [ /pattern/ ] { print fields }');
        return 1;
    }
    let filter = null;
    try {
        filter = match[1] === undefined ? null : new RegExp(match[1]);
    } catch (error) {
        ctx.perror(`awk: ${error.message}`);
        return 1;
    }
    const expressions = match[2].split(',').map(value => value.trim());
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((line, index) => {
        if (filter && !filter.test(line)) return;
        const fields = line.trim().split(separator);
        const values = expressions.map(expression => {
            if (expression === '$0') return line;
            if (expression === 'NR') return String(index + 1);
            if (expression === 'NF') return String(fields.length);
            if (/^\$\d+$/.test(expression))
                return fields[Number(expression.slice(1)) - 1] ?? '';
            return expression.replace(/^"(.*)"$/, '$1');
        });
        ctx.printf(values.join(' '));
    });
    return 0;
}

function xargs(ctx) {
    const args = [...ctx.args];
    let count = Infinity;
    if (args[0] === '-n') {
        count = Number(args.splice(0, 2)[1]);
        if (!Number.isInteger(count) || count < 1) {
            ctx.perror('xargs: invalid argument count');
            return 1;
        }
    }
    const command = args.length ? args : ['echo'];
    const values = ctx.stdin.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const cleaned = values.map(value =>
        value.replace(/^(['"])(.*)\1$/, '$2'));
    let status = 0;
    for (let index = 0; index < cleaned.length || index === 0; index += count) {
        const batch = count === Infinity ? cleaned : cleaned.slice(index, index + count);
        if (!batch.length && cleaned.length) break;
        status = forward_result(ctx, ctx.run([...command, ...batch]));
        if (count === Infinity) break;
    }
    return status;
}

function strings(ctx) {
    const files = ctx.args.filter(arg => !arg.startsWith('-'));
    try {
        const content = read_inputs(ctx, files);
        for (const match of content.matchAll(/[ -~]{4,}/g))
            ctx.printf(match[0]);
        return 0;
    } catch (error) {
        ctx.perror(`strings: ${error.message}`);
        return 1;
    }
}

function base64(ctx) {
    const decode = ctx.args.includes('-d') || ctx.args.includes('--decode');
    const files = ctx.args.filter(arg => !arg.startsWith('-'));
    try {
        const content = read_inputs(ctx, files);
        ctx.printf(decode ? decode_base64(content) : encode_base64(content));
        return 0;
    } catch (error) {
        ctx.perror(`base64: ${error.message}`);
        return 1;
    }
}

function cksum(ctx) {
    const files = ctx.args.length ? ctx.args : ['-'];
    let status = 0;
    for (const file of files) {
        try {
            const content = file === '-' ? ctx.stdin : ctx.read(ctx.realpath(file));
            const length = new TextEncoder().encode(content).length;
            ctx.printf(`${crc32(content)} ${length}${file === '-' ? '' : ` ${file}`}`);
        } catch (error) {
            ctx.perror(`cksum: ${file}: ${error.message}`);
            status = 1;
        }
    }
    return status;
}

function cmp(ctx) {
    if (ctx.args.length !== 2) {
        ctx.perror('cmp: usage: cmp FILE1 FILE2');
        return 2;
    }
    try {
        const first = ctx.read(ctx.realpath(ctx.args[0]));
        const second = ctx.read(ctx.realpath(ctx.args[1]));
        if (first === second) return 0;
        let index = 0;
        while (first[index] === second[index]) index++;
        const line = first.slice(0, index).split('\n').length;
        ctx.printf(`${ctx.args[0]} ${ctx.args[1]} differ: byte ${index + 1}, line ${line}`);
        return 1;
    } catch (error) {
        ctx.perror(`cmp: ${error.message}`);
        return 2;
    }
}

function diff(ctx) {
    if (ctx.args.length !== 2) {
        ctx.perror('diff: usage: diff FILE1 FILE2');
        return 2;
    }
    try {
        const first = ctx.read(ctx.realpath(ctx.args[0])).replace(/\n$/, '').split('\n');
        const second = ctx.read(ctx.realpath(ctx.args[1])).replace(/\n$/, '').split('\n');
        if (first.join('\n') === second.join('\n')) return 0;
        ctx.printf(`--- ${ctx.args[0]}`);
        ctx.printf(`+++ ${ctx.args[1]}`);
        const length = Math.max(first.length, second.length);
        for (let index = 0; index < length; index++) {
            if (first[index] === second[index]) continue;
            if (first[index] !== undefined) ctx.printf(`-${first[index]}`);
            if (second[index] !== undefined) ctx.printf(`+${second[index]}`);
        }
        return 1;
    } catch (error) {
        ctx.perror(`diff: ${error.message}`);
        return 2;
    }
}

function hexdump(ctx) {
    const files = ctx.args.filter(arg => arg !== '-C');
    try {
        const bytes = new TextEncoder().encode(read_inputs(ctx, files));
        for (let offset = 0; offset < bytes.length; offset += 16) {
            const chunk = bytes.slice(offset, offset + 16);
            const hex = [...chunk].map(byte =>
                byte.toString(16).padStart(2, '0')).join(' ');
            const ascii = [...chunk].map(byte =>
                byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
            ctx.printf(
                `${offset.toString(16).padStart(8, '0')}  ` +
                `${hex.padEnd(47)}  |${ascii}|`);
        }
        ctx.printf(bytes.length.toString(16).padStart(8, '0'));
        return 0;
    } catch (error) {
        ctx.perror(`hexdump: ${error.message}`);
        return 1;
    }
}

function raw_bytes(content) {
    const text = String(content);
    const bytes = [];
    for (let index = 0; index < text.length; index++)
        bytes.push(text.charCodeAt(index) & 0xff);
    return bytes;
}

function parse_xxd_number(value) {
    const text = String(value ?? '').replace(/^\+/, '');
    const number = Number(/^0x/i.test(text) ? text : text.replace(/^0/, '') || '0');
    if (!Number.isInteger(number) || number < 0)
        throw new Error(`invalid number '${value}'`);
    return number;
}

function take_xxd_value(args, index, option) {
    const arg = args[index];
    if (arg.length > option.length) return [arg.slice(option.length), index];
    if (index + 1 >= args.length) throw new Error(`${option}: missing argument`);
    return [args[index + 1], index + 1];
}

function parse_xxd_args(args) {
    const options = {
        cols: null,
        group: 2,
        length: null,
        seek: 0,
        plain: false,
        upper: false,
        files: [],
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--') {
            options.files.push(...args.slice(index + 1));
            break;
        }
        if (arg === '-p' || arg === '-ps') {
            options.plain = true;
            continue;
        }
        if (arg === '-u') {
            options.upper = true;
            continue;
        }
        if (arg === '-c' || arg.startsWith('-c')) {
            const [value, consumed] = take_xxd_value(args, index, '-c');
            options.cols = parse_xxd_number(value);
            index = consumed;
            continue;
        }
        if (arg === '-g' || arg.startsWith('-g')) {
            const [value, consumed] = take_xxd_value(args, index, '-g');
            options.group = parse_xxd_number(value);
            index = consumed;
            continue;
        }
        if (arg === '-l' || arg.startsWith('-l')) {
            const [value, consumed] = take_xxd_value(args, index, '-l');
            options.length = parse_xxd_number(value);
            index = consumed;
            continue;
        }
        if (arg === '-s' || arg.startsWith('-s')) {
            const [value, consumed] = take_xxd_value(args, index, '-s');
            options.seek = parse_xxd_number(value);
            index = consumed;
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`unsupported option '${arg}'`);
        options.files.push(arg);
    }
    if (options.cols !== null && options.cols < 1)
        throw new Error('column count must be positive');
    if (options.group < 1) throw new Error('group size must be positive');
    return options;
}

function format_xxd_hex(chunk, cols, group, upper) {
    const groups = [];
    for (let index = 0; index < chunk.length; index += group) {
        groups.push(chunk
            .slice(index, index + group)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join(''));
    }
    const full_groups = Math.ceil(cols / group);
    const width = (cols * 2) + Math.max(0, full_groups - 1);
    const hex = groups.join(' ').padEnd(width);
    return upper ? hex.toUpperCase() : hex;
}

function xxd(ctx) {
    let options;
    try {
        options = parse_xxd_args(ctx.args);
        const content = read_inputs(ctx, options.files);
        let bytes = raw_bytes(content).slice(options.seek);
        if (options.length !== null) bytes = bytes.slice(0, options.length);

        if (options.plain) {
            const line_bytes = options.cols ?? 30;
            for (let offset = 0; offset < bytes.length; offset += line_bytes) {
                let hex = bytes
                    .slice(offset, offset + line_bytes)
                    .map(byte => byte.toString(16).padStart(2, '0'))
                    .join('');
                if (options.upper) hex = hex.toUpperCase();
                ctx.printf(hex);
            }
            return 0;
        }

        const cols = options.cols ?? 16;
        for (let offset = 0; offset < bytes.length; offset += cols) {
            const chunk = bytes.slice(offset, offset + cols);
            const hex = format_xxd_hex(chunk, cols, options.group, options.upper);
            const ascii = chunk.map(byte =>
                byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
            ctx.printf(
                `${(options.seek + offset).toString(16).padStart(8, '0')}: ` +
                `${hex}  ${ascii}`);
        }
        return 0;
    } catch (error) {
        ctx.perror(`xxd: ${error.message}`);
        return 1;
    }
}

function evaluate_test(args, ctx) {
    if (!args.length) return false;
    if (args[0] === '!') return !evaluate_test(args.slice(1), ctx);
    if (args.length === 1) return args[0].length > 0;
    if (args.length === 2) {
        if (args[0] === '-n') return args[1].length > 0;
        if (args[0] === '-z') return args[1].length === 0;
        if (['-e', '-f', '-d', '-r', '-w', '-x'].includes(args[0])) {
            try {
                const stat = ctx.stat(ctx.realpath(args[1]));
                if (args[0] === '-e') return true;
                if (args[0] === '-f') return stat.type === 'file';
                if (args[0] === '-d') return stat.type === 'dir';
                const mask = args[0] === '-r' ? 4 : args[0] === '-w' ? 2 : 1;
                ctx.access(ctx.realpath(args[1]), mask);
                return true;
            } catch {
                return false;
            }
        }
    }
    if (args.length === 3) {
        const [left, operator, right] = args;
        if (operator === '=' || operator === '==') return left === right;
        if (operator === '!=') return left !== right;
        if (operator === '-eq') return Number(left) === Number(right);
        if (operator === '-ne') return Number(left) !== Number(right);
        if (operator === '-lt') return Number(left) < Number(right);
        if (operator === '-le') return Number(left) <= Number(right);
        if (operator === '-gt') return Number(left) > Number(right);
        if (operator === '-ge') return Number(left) >= Number(right);
    }
    return false;
}

function test(ctx) {
    return evaluate_test(ctx.args, ctx) ? 0 : 1;
}

function test_bracket(ctx) {
    if (ctx.args.at(-1) !== ']') {
        ctx.perror('[: missing ]');
        return 2;
    }
    return evaluate_test(ctx.args.slice(0, -1), ctx) ? 0 : 1;
}

function expr(ctx) {
    if (!ctx.args.length) {
        ctx.perror('expr: missing operand');
        return 2;
    }
    const expression = ctx.args.join(' ');
    if (!/^[0-9+\-*/%().<>=!&| \t]+$/.test(expression)) {
        ctx.perror('expr: unsupported expression');
        return 2;
    }
    try {
        const value = Function(`"use strict"; return Number(${expression});`)();
        ctx.printf(value);
        return value === 0 ? 1 : 0;
    } catch {
        ctx.perror('expr: syntax error');
        return 2;
    }
}

function bc(ctx) {
    const expression = (ctx.args.length ? ctx.args.join(' ') : ctx.stdin).trim();
    if (!expression || !/^[0-9+\-*/%(). \t\n]+$/.test(expression)) {
        ctx.perror('bc: unsupported expression');
        return 1;
    }
    try {
        const statements = expression.split(/[;\n]+/).filter(Boolean);
        for (const statement of statements)
            ctx.printf(Function(`"use strict"; return (${statement});`)());
        return 0;
    } catch {
        ctx.perror('bc: syntax error');
        return 1;
    }
}

function pgrep(ctx) {
    const full = ctx.args.includes('-f');
    const pattern = ctx.args.find(arg => !arg.startsWith('-'));
    if (!pattern) {
        ctx.perror('pgrep: missing pattern');
        return 2;
    }
    let expression;
    try {
        expression = new RegExp(pattern);
    } catch (error) {
        ctx.perror(`pgrep: ${error.message}`);
        return 2;
    }
    const matches = ctx.list_procs().filter(task =>
        expression.test(full
            ? `${task.comm} ${Object.values(task.envp).join(' ')}`
            : task.comm));
    matches.forEach(task => ctx.printf(task.pid));
    return matches.length ? 0 : 1;
}

function pidof(ctx) {
    const names = new Set(ctx.args);
    const pids = ctx.list_procs()
        .filter(task => names.has(task.comm))
        .map(task => task.pid);
    if (pids.length) ctx.printf(pids.join(' '));
    return pids.length ? 0 : 1;
}

function pkill(ctx) {
    const pattern = ctx.args.find(arg => !arg.startsWith('-'));
    if (!pattern) {
        ctx.perror('pkill: missing pattern');
        return 2;
    }
    let expression;
    try {
        expression = new RegExp(pattern);
    } catch (error) {
        ctx.perror(`pkill: ${error.message}`);
        return 2;
    }
    const targets = ctx.list_procs()
        .filter(task => task.pid !== ctx.getpid() && expression.test(task.comm));
    for (const task of targets) {
        try {
            ctx.kill(task.pid, SIGTERM);
        } catch (error) {
            ctx.perror(`pkill: ${task.pid}: ${error.message}`);
        }
    }
    return targets.length ? 0 : 1;
}

function killall(ctx) {
    const name = ctx.args.at(-1);
    if (!name) {
        ctx.perror('killall: missing process name');
        return 1;
    }
    const targets = ctx.list_procs()
        .filter(task => task.pid !== ctx.getpid() && task.comm === name);
    for (const task of targets) ctx.kill(task.pid, SIGTERM);
    return targets.length ? 0 : 1;
}

function time(ctx) {
    if (!ctx.args.length) {
        ctx.perror('time: missing command');
        return 1;
    }
    const start = Date.now();
    const status = forward_result(ctx, ctx.run(ctx.args));
    const elapsed = (Date.now() - start) / 1000;
    ctx.stderr_buf.push({
        text: `real\t${elapsed.toFixed(3)}s`,
        tone: 'muted',
    });
    return status;
}

function tty(ctx) {
    if (!ctx.isatty(0)) {
        ctx.printf('not a tty');
        return 1;
    }
    ctx.printf('/dev/pts/0');
    return 0;
}

function stty(ctx) {
    const {
        ECHO,
        ICANON,
        ISIG,
        TIOCGWINSZ,
        TIOCSWINSZ,
    } = ctx.constants;
    let termios;
    let winsize;
    try {
        termios = ctx.tcgetattr(0);
        winsize = ctx.ioctl(0, TIOCGWINSZ);
    } catch (error) {
        ctx.perror(`stty: standard input: ${error.message}`);
        return 1;
    }

    const show = ctx.args.length === 0 || ctx.args.includes('-a');
    if (show) {
        const flag = (bit, name) =>
            `${termios.lflag & bit ? '' : '-'}${name}`;
        ctx.printf(
            `speed ${termios.ispeed} baud; rows ${winsize.rows}; ` +
            `columns ${winsize.cols}; ${flag(ISIG, 'isig')} ` +
            `${flag(ICANON, 'icanon')} ${flag(ECHO, 'echo')}`
        );
        return 0;
    }

    let status = 0;
    for (let index = 0; index < ctx.args.length; index++) {
        const arg = ctx.args[index];
        if (arg === 'raw') termios.lflag &= ~(ICANON | ECHO);
        else if (arg === 'cooked' || arg === 'sane')
            termios.lflag |= ISIG | ICANON | ECHO;
        else if (arg === 'echo') termios.lflag |= ECHO;
        else if (arg === '-echo') termios.lflag &= ~ECHO;
        else if (arg === 'icanon') termios.lflag |= ICANON;
        else if (arg === '-icanon') termios.lflag &= ~ICANON;
        else if (arg === 'isig') termios.lflag |= ISIG;
        else if (arg === '-isig') termios.lflag &= ~ISIG;
        else if (arg === 'rows' || arg === 'cols' || arg === 'columns') {
            const value = Number(ctx.args[++index]);
            if (!Number.isInteger(value) || value < 0) {
                ctx.perror(`stty: invalid ${arg} value`);
                status = 1;
                break;
            }
            if (arg === 'rows') winsize.rows = value;
            else winsize.cols = value;
        } else {
            ctx.perror(`stty: invalid argument '${arg}'`);
            status = 1;
            break;
        }
    }
    if (status !== 0) return status;

    try {
        ctx.tcsetattr(0, termios);
        ctx.ioctl(0, TIOCSWINSZ, winsize);
        return 0;
    } catch (error) {
        ctx.perror(`stty: ${error.message}`);
        return 1;
    }
}

function arch(ctx) {
    ctx.printf(ctx.uname().machine);
    return 0;
}

function nproc(ctx) {
    ctx.printf('1');
    return 0;
}

function lscpu(ctx) {
    ctx.printf('Architecture:        js-x64');
    ctx.printf('CPU op-mode(s):      32-bit, 64-bit');
    ctx.printf('Byte Order:          Little Endian');
    ctx.printf('CPU(s):              1');
    ctx.printf('Vendor ID:           JSNix');
    ctx.printf('Model name:          JavaScript Virtual CPU');
    return 0;
}

function lsblk(ctx) {
    ctx.printf('NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS');
    ctx.printf('jsda     8:0    0    1G  0 disk');
    ctx.printf('`-jsda1  8:1    0    1G  0 part /');
    return 0;
}

function blkid(ctx) {
    ctx.printf('/dev/jsda1: UUID="4a534c4e-5558" TYPE="jsfs"');
    return 0;
}

function mount(ctx) {
    if (ctx.args.length) {
        ctx.perror('mount: simulated file systems cannot be changed');
        return 1;
    }
    ctx.printf('jsfs on / type jsfs (rw,relatime)');
    ctx.printf('proc on /proc type proc (rw,relatime)');
    return 0;
}

function findmnt(ctx) {
    ctx.printf('TARGET SOURCE FSTYPE OPTIONS');
    ctx.printf('/      jsfs   jsfs   rw,relatime');
    ctx.printf('/proc  proc   proc   rw,relatime');
    return 0;
}

function lsmod(ctx) {
    ctx.printf('Module                  Size  Used by');
    for (const name of loaded_modules)
        ctx.printf(`${name.padEnd(22)} 4096  0`);
    return 0;
}

function modprobe(ctx) {
    const remove = ctx.args[0] === '-r';
    const name = remove ? ctx.args[1] : ctx.args[0];
    if (!name) {
        ctx.perror('modprobe: missing module name');
        return 1;
    }
    if (ctx.getuid() !== 0) {
        ctx.perror('modprobe: Operation not permitted');
        return 1;
    }
    if (remove) loaded_modules.delete(name);
    else loaded_modules.add(name);
    return 0;
}

function sysctl(ctx) {
    const value_of = key => key === 'kernel.hostname'
        ? ctx.read('/etc/hostname').trim()
        : SYSCTL[key];
    const set_value = (key, value) => {
        if (key === 'kernel.hostname') ctx.write('/etc/hostname', value + '\n');
        SYSCTL[key] = value;
    };
    if (!ctx.args.length || ctx.args.includes('-a')) {
        for (const [key, value] of Object.entries(SYSCTL))
            ctx.printf(`${key} = ${key === 'kernel.hostname' ? value_of(key) : value}`);
        return 0;
    }
    let status = 0;
    for (const argument of ctx.args) {
        const equals = argument.indexOf('=');
        const key = equals < 0 ? argument : argument.slice(0, equals);
        if (!(key in SYSCTL)) {
            ctx.perror(`sysctl: cannot stat /proc/sys/${key.replaceAll('.', '/')}`);
            status = 1;
            continue;
        }
        if (equals >= 0) {
            if (ctx.getuid() !== 0) {
                ctx.perror(`sysctl: permission denied on key '${key}'`);
                status = 1;
                continue;
            }
            set_value(key, argument.slice(equals + 1));
        }
        ctx.printf(`${key} = ${value_of(key)}`);
    }
    return status;
}

function logger(ctx) {
    const message = ctx.args.join(' ') || ctx.stdin.trim();
    if (!message) return 0;
    ctx.syslog(`${ctx.getlogin()}: ${message}`);
    return 0;
}

function journalctl(ctx) {
    const paths = ['/var/log/kern.log', '/var/log/auth.log', '/var/log/syslog'];
    for (const path of paths) {
        try {
            emit_text(ctx, ctx.read(path));
        } catch { /* Skip logs that the current user cannot read. */ }
    }
    return 0;
}

function w(ctx) {
    const info = ctx.sysinfo();
    ctx.printf(
        ` ${new Date().toLocaleTimeString()} up ${info.uptime}s, 1 user, ` +
        'load average: 0.01, 0.01, 0.00');
    ctx.printf('USER       TTY      FROM             LOGIN@   WHAT');
    ctx.printf(`${ctx.getlogin().padEnd(10)} pts/0    -                now      bash`);
    return 0;
}

function last(ctx) {
    ctx.printf(
        `${ctx.getlogin().padEnd(10)} pts/0        ` +
        `${new Date(ksyms.boot_time).toLocaleString()}   still logged in`);
    ctx.printf(`reboot     system boot  ${new Date(ksyms.boot_time).toLocaleString()}`);
    return 0;
}

function ip(ctx) {
    const command = ctx.args[0] ?? 'addr';
    if (command === 'addr' || command === 'a') {
        for (const item of VIRTUAL_INTERFACES) {
            ctx.printf(`${item.index}: ${item.name}: <${item.flags}> mtu 1500`);
            ctx.printf(`    link/ether ${item.mac}`);
            ctx.printf(`    inet ${item.address} scope ${item.name === 'lo' ? 'host' : 'global'} ${item.name}`);
        }
        return 0;
    }
    if (command === 'link' || command === 'l') {
        for (const item of VIRTUAL_INTERFACES)
            ctx.printf(`${item.index}: ${item.name}: <${item.flags}> mtu 1500`);
        return 0;
    }
    if (command === 'route' || command === 'r') {
        VIRTUAL_ROUTES.forEach(route => ctx.printf(route));
        return 0;
    }
    ctx.perror(`ip: unknown command '${command}'`);
    return 1;
}

function ifconfig(ctx) {
    for (const item of VIRTUAL_INTERFACES) {
        ctx.printf(`${item.name}: flags=<${item.flags}>  mtu 1500`);
        ctx.printf(`        inet ${item.address.split('/')[0]}  netmask 255.255.255.0`);
        ctx.printf(`        ether ${item.mac}`);
    }
    return 0;
}

function route(ctx) {
    ctx.printf('Kernel IP routing table');
    ctx.printf('Destination Gateway     Genmask         Flags Iface');
    ctx.printf('default     10.0.2.2    0.0.0.0         UG    eth0');
    ctx.printf('10.0.2.0    0.0.0.0     255.255.255.0   U     eth0');
    return 0;
}

function sockets(ctx) {
    ctx.printf('Netid State  Local Address:Port Peer Address:Port Process');
    ctx.printf('tcp   LISTEN 127.0.0.1:8080     0.0.0.0:*       users:(("jsnix",pid=1))');
    ctx.printf('udp   UNCONN 10.0.2.15:68       0.0.0.0:*       users:(("dhcp",pid=1))');
}

function ss(ctx) {
    sockets(ctx);
    return 0;
}

function netstat(ctx) {
    sockets(ctx);
    return 0;
}

function ping(ctx) {
    const host = ctx.args.find(arg => !arg.startsWith('-') &&
        ctx.args[ctx.args.indexOf(arg) - 1] !== '-c');
    if (!host) {
        ctx.perror('ping: missing host operand');
        return 2;
    }
    const known = ['localhost', '127.0.0.1', 'jsnix.local', '10.0.2.2'];
    const count = parse_count(ctx.args);
    const address = host === 'localhost' ? '127.0.0.1'
        : host === 'jsnix.local' ? '10.0.2.15'
            : host;
    ctx.printf(`PING ${host} (${address}) 56(84) bytes of data.`);
    if (known.includes(host)) {
        for (let index = 1; index <= count; index++)
            ctx.printf(
                `64 bytes from ${address}: icmp_seq=${index} ` +
                `ttl=64 time=0.0${index} ms`
            );
        ctx.printf(`--- ${host} ping statistics ---`);
        ctx.printf(
            `${count} packets transmitted, ` +
            `${count} received, 0% packet loss`
        );
        return 0;
    }

    let received = 0;
    for (let index = 1; index <= count; index++) {
        const probe_url = /^https?:\/\//.test(host)
            ? host
            : `https://${host}/`;
        try {
            const response = http_request(ctx, probe_url, {method: 'GET'});
            if (!response) throw new Error('network backend unavailable');
            received++;
            ctx.printf(
                `64 bytes from ${address}: icmp_seq=${index} ` +
                `ttl=64 time=${response.elapsed_ms.toFixed(1)} ms`
            );
        } catch (error) {
            ctx.perror(`ping: ${host}: ${error.message}`);
        }
    }
    ctx.printf(`--- ${host} ping statistics ---`);
    const loss = Math.round(((count - received) / count) * 100);
    ctx.printf(
        `${count} packets transmitted, ` +
        `${received} received, ${loss}% packet loss`
    );
    return received > 0 ? 0 : 2;
}

function curl(ctx) {
    const headers = ctx.args.includes('-I');
    const output_index = ctx.args.indexOf('-o');
    const output_file = output_index >= 0 ? ctx.args[output_index + 1] : null;
    const url = ctx.args.find(arg =>
        /^(https?|file):/.test(arg));
    if (!url) {
        ctx.perror('curl: no URL specified');
        return 2;
    }
    let response;
    if (url.startsWith('file://')) {
        try {
            response = {
                status: '200 OK',
                type: 'text/plain',
                body: ctx.read(url.slice('file://'.length)),
            };
        } catch (error) {
            ctx.perror(`curl: ${error.message}`);
            return 37;
        }
    } else {
        try {
            response = http_request(ctx, url, {
                method: headers ? 'HEAD' : 'GET',
            });
        } catch (error) {
            ctx.perror(`curl: ${error.message}`);
            return 6;
        }
    }
    if (!response) {
        ctx.perror(`curl: network backend unavailable for ${url}`);
        return 6;
    }
    const content = headers
        ? `HTTP/1.1 ${response.status}\nContent-Type: ${response.type}\n`
        : response.body;
    if (output_file) ctx.write(ctx.realpath(output_file), content);
    else emit_text(ctx, content);
    return 0;
}

function wget(ctx) {
    const output_index = ctx.args.indexOf('-O');
    const output_file = output_index >= 0 ? ctx.args[output_index + 1] : null;
    const url = ctx.args.find(arg => /^https?:/.test(arg));
    if (!url) {
        ctx.perror('wget: missing URL');
        return 1;
    }
    let response;
    try {
        response = http_request(ctx, url, {method: 'GET'});
    } catch (error) {
        ctx.perror(`wget: ${error.message}`);
        return 4;
    }
    if (!response) {
        ctx.perror(`wget: network backend unavailable for '${url}'`);
        return 4;
    }
    const filename = output_file ??
        (url.split('/').filter(Boolean).at(-1) || 'index.html');
    ctx.write(ctx.realpath(filename), response.body);
    ctx.printf(`Saving to: '${filename}'`);
    ctx.printf(`${response.body.length} bytes written`);
    return 0;
}

const MAN_SECTIONS = ['1', '2', '3', '4', '5', '6', '7', '8'];

function manual_candidates(name, section = null) {
    const sections = section ? [section] : MAN_SECTIONS;
    return sections.map(sec => `/usr/share/man/man${sec}/${name}.${sec}`);
}

function find_manual(ctx, name, section = null) {
    for (const path of manual_candidates(name, section)) {
        try {
            ctx.stat(path);
            return path;
        } catch {
            // Try the next manual section.
        }
    }
    return null;
}

function list_manuals(ctx) {
    const entries = [];
    for (const section of MAN_SECTIONS) {
        const dir = `/usr/share/man/man${section}`;
        let files;
        try {
            files = ctx.readdir(dir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(`.${section}`)) continue;
            const name = file.slice(0, -(section.length + 1));
            const path = `${dir}/${file}`;
            let content;
            try {
                content = ctx.read(path);
            } catch {
                continue;
            }
            entries.push({
                name,
                section,
                path,
                summary: manual_summary(name, content),
            });
        }
    }
    return entries.sort((a, b) =>
        a.name === b.name
            ? Number(a.section) - Number(b.section)
            : a.name.localeCompare(b.name));
}

function man(ctx) {
    const args = ctx.args.filter(arg => !arg.startsWith('-'));
    const section = /^[1-8]$/.test(args[0] ?? '') ? args.shift() : null;
    const name = args[0];
    if (!name) {
        ctx.perror('What manual page do you want?');
        return 1;
    }
    const path = find_manual(ctx, name, section);
    if (!path) {
        ctx.perror(`No manual entry for ${name}`);
        return 16;
    }
    emit_text(ctx, ctx.read(path));
    return 0;
}

function apropos(ctx) {
    const query = ctx.args.join(' ').toLowerCase();
    if (!query) {
        ctx.perror('apropos: missing keyword');
        return 1;
    }
    const matches = list_manuals(ctx).filter(entry =>
        entry.name.toLowerCase().includes(query) ||
        entry.summary.toLowerCase().includes(query));
    for (const entry of matches) ctx.printf(entry.summary);
    return matches.length ? 0 : 1;
}

function whereis(ctx) {
    for (const name of ctx.args) {
        const path = ctx.get_binary_path(name);
        const manual = find_manual(ctx, name);
        ctx.printf(`${name}:${path ? ` ${path}` : ''}${manual ? ` ${manual}` : ''}`);
    }
    return 0;
}

function command(ctx) {
    if (ctx.args[0] === '-v' || ctx.args[0] === '-V') {
        const name = ctx.args[1];
        const path = ctx.get_binary_path(name);
        if (path) {
            ctx.printf(path);
            return 0;
        }
        return 1;
    }
    if (!ctx.args.length) return 0;
    return forward_result(ctx, ctx.run(ctx.args));
}

register_binary('ln', ln);
register_binary('readlink', readlink);
register_binary('realpath', realpath);
register_binary('file', file);
register_binary('mktemp', mktemp);
register_binary('sync', sync);
register_binary('reboot', reboot);
register_binary('shutdown', shutdown);
register_binary('tac', tac);
register_binary('nl', nl);
register_binary('rev', rev);
register_binary('paste', paste);
register_binary('fold', fold);
register_binary('sed', sed);
register_binary('awk', awk);
register_binary('xargs', xargs);
register_binary('strings', strings);
register_binary('base64', base64);
register_binary('cksum', cksum);
register_binary('cmp', cmp);
register_binary('diff', diff);
register_binary('hexdump', hexdump);
register_binary('xxd', xxd);
register_binary('test', test);
register_binary('[', test_bracket);
register_binary('expr', expr);
register_binary('bc', bc);
register_binary('pgrep', pgrep);
register_binary('pidof', pidof);
register_binary('pkill', pkill);
register_binary('killall', killall);
register_binary('time', time);
register_binary('tty', tty);
register_binary('stty', stty);
register_binary('arch', arch);
register_binary('nproc', nproc);
register_binary('lscpu', lscpu);
register_binary('lsblk', lsblk);
register_binary('blkid', blkid);
register_binary('mount', mount);
register_binary('findmnt', findmnt);
register_binary('lsmod', lsmod);
register_binary('modprobe', modprobe);
register_binary('sysctl', sysctl);
register_binary('logger', logger);
register_binary('journalctl', journalctl);
register_binary('w', w);
register_binary('last', last);
register_binary('ip', ip);
register_binary('ifconfig', ifconfig);
register_binary('route', route);
register_binary('ss', ss);
register_binary('netstat', netstat);
register_binary('ping', ping);
register_binary('curl', curl);
register_binary('wget', wget);
register_binary('man', man);
register_binary('apropos', apropos);
register_binary('whereis', whereis);
register_binary('command', command);
