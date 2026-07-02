/**
 * usr/shell/parser.js - Tokenization and command-list parsing
 */

'use strict';

export function tokenize(line, expand) {
    const tokens = [];
    const literal_dollar = '\uE000';
    const literal_tilde = '\uE001';
    let cur = '';
    let quote = null;
    let token_started = false;

    const flush = () => {
        if (!token_started) return;
        tokens.push(expand(cur)
            .replaceAll(literal_dollar, '$')
            .replaceAll(literal_tilde, '~'));
        cur = '';
        token_started = false;
    };

    const read_command_substitution = start => {
        let depth = 1;
        let value = '$(';
        let inner_quote = null;
        let inner_escaped = false;
        for (let i = start + 2; i < line.length; i++) {
            const ch = line[i];
            value += ch;
            if (inner_escaped) {
                inner_escaped = false;
                continue;
            }
            if (ch === '\\') {
                inner_escaped = true;
                continue;
            }
            if (inner_quote) {
                if (ch === inner_quote) inner_quote = null;
                continue;
            }
            if (ch === '\'' || ch === '"') {
                inner_quote = ch;
                continue;
            }
            if (ch === '(') depth++;
            else if (ch === ')' && --depth === 0)
                return {value, end: i};
        }
        throw new Error('unexpected EOF while looking for matching `)`');
    };

    for (let i = 0; i < line.length; i++) {
        const c = line[i];

        if (quote === "'") {
            if (c === "'") {
                quote = null;
                continue;
            }
            cur += c === '$' ? literal_dollar
                : c === '~' && cur === '' ? literal_tilde
                    : c;
            token_started = true;
            continue;
        }

        if (quote === '"') {
            if (c === '"') {
                quote = null;
                continue;
            }
            if (c === '$' && line[i + 1] === '(') {
                const command = read_command_substitution(i);
                cur += command.value;
                i = command.end;
                token_started = true;
                continue;
            }
            if (c === '\\' && i + 1 < line.length) {
                const next = line[++i];
                cur += next === '$' ? literal_dollar : next;
            } else {
                cur += c === '~' && cur === '' ? literal_tilde : c;
            }
            token_started = true;
            continue;
        }

        if (c === "'" || c === '"') {
            quote = c;
            token_started = true;
            continue;
        }
        if (c === '\\' && i + 1 < line.length) {
            const next = line[++i];
            cur += next === '$' ? literal_dollar
                : next === '~' && cur === '' ? literal_tilde
                    : next;
            token_started = true;
            continue;
        }
        if (c === '$' && line[i + 1] === '(') {
            const command = read_command_substitution(i);
            cur += command.value;
            i = command.end;
            token_started = true;
            continue;
        }
        if (/\s/.test(c)) {
            flush();
            continue;
        }
        if (c === '2' && cur === '' && line[i + 1] === '>') {
            flush();
            if (line[i + 2] === '>') {
                tokens.push('2>>');
                i += 2;
            } else {
                tokens.push('2>');
                i++;
            }
            continue;
        }
        if (c === '|' || c === '<' || c === '>') {
            flush();
            if (c === '<' && line.slice(i, i + 3) === '<<<') {
                tokens.push('<<<');
                i += 2;
            } else if (c === '>' && line[i + 1] === '>') {
                tokens.push('>>');
                i++;
            } else {
                tokens.push(c);
            }
            continue;
        }
        cur += c;
        token_started = true;
    }
    if (quote) throw new Error('unexpected EOF while looking for matching quote');
    flush();
    return tokens;
}

export function parse_pipeline(line, expand) {
    const stages = [];
    let stage = {
        tokens: [],
        redir_out: null,
        redir_in: null,
        redir_append: false,
        redir_err: null,
        redir_err_append: false,
        here_string: null,
    };
    const tokens = tokenize(line, expand);

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '|') {
            if (!stage.tokens.length)
                throw new Error('syntax error near unexpected token `|`');
            stages.push(stage);
            stage = {
                tokens: [],
                redir_out: null,
                redir_in: null,
                redir_append: false,
                redir_err: null,
                redir_err_append: false,
                here_string: null,
            };
            continue;
        }
        if (token === '<' || token === '>' || token === '>>' ||
            token === '2>' || token === '2>>' || token === '<<<') {
            const target = tokens[++i];
            if (!target || target === '|' || target === '<' ||
                target === '>' || target === '>>' ||
                target === '2>' || target === '2>>' || target === '<<<')
                throw new Error(`syntax error near unexpected token \`${target ?? 'newline'}\``);
            if (token === '<') {
                stage.redir_in = target;
            } else if (token === '<<<') {
                stage.here_string = target;
            } else if (token === '2>' || token === '2>>') {
                stage.redir_err = target;
                stage.redir_err_append = token === '2>>';
            } else {
                stage.redir_out = target;
                stage.redir_append = token === '>>';
            }
            continue;
        }
        stage.tokens.push(token);
    }

    if (!stage.tokens.length) {
        if (stages.length) throw new Error('syntax error: unexpected end of file');
        return [];
    }
    stages.push(stage);
    return stages;
}

export function parse_command_list(line) {
    const commands = [];
    let current = '';
    let quote = null;
    let escaped = false;
    let operator = null;
    let paren_depth = 0;
    let brace_depth = 0;
    let ended_with_background = false;

    const flush = (next_operator, background = false) => {
        const command = current.trim();
        if (!command)
            throw new Error(`syntax error near unexpected token \`${next_operator}\``);
        commands.push({operator, command, background});
        current = '';
        operator = next_operator;
        ended_with_background = background;
    };

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (escaped) {
            current += char;
            escaped = false;
            ended_with_background = false;
            continue;
        }
        if (char === '\\') {
            current += char;
            escaped = true;
            ended_with_background = false;
            continue;
        }
        if (quote) {
            current += char;
            if (char === quote) quote = null;
            ended_with_background = false;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            ended_with_background = false;
            continue;
        }
        if (char === '(') {
            paren_depth++;
            current += char;
            ended_with_background = false;
            continue;
        }
        if (char === ')' && paren_depth > 0) {
            paren_depth--;
            current += char;
            ended_with_background = false;
            continue;
        }
        if (char === '{') {
            brace_depth++;
            current += char;
            ended_with_background = false;
            continue;
        }
        if (char === '}' && brace_depth > 0) {
            brace_depth--;
            current += char;
            ended_with_background = false;
            continue;
        }
        const pair = line.slice(i, i + 2);
        if ((pair === '&&' || pair === '||') && paren_depth === 0 && brace_depth === 0) {
            flush(pair);
            i++;
            continue;
        }
        if (char === ';' && paren_depth === 0 && brace_depth === 0) {
            flush(';');
            continue;
        }
        if (char === '&' && paren_depth === 0 && brace_depth === 0) {
            flush(';', true);
            continue;
        }
        current += char;
        if (!/\s/.test(char)) ended_with_background = false;
    }
    if (quote) throw new Error('unexpected EOF while looking for matching quote');
    if (current.trim()) commands.push({operator, command: current.trim()});
    else if (operator && !ended_with_background)
        throw new Error('syntax error: unexpected end of file');
    return commands;
}
