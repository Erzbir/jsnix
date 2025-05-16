import {CONFIG} from "./config.js";
import * as fend from "./frontend.js";
import {createDOMElements} from "./frontend.js";
import * as fs from "./system/fs.js";
import {FILE_TYPE} from "./system/fs.js";
import {getpwnam, getpwuid} from "./system/pwd.js";
import {getuid, setgid, setuid} from "./system/unistd.js";
import {getspnam} from "./system/shadow.js";
import {createProcess, setCurrent} from "./system/sys/proc.js";

const STATE = {
    loginAttempts: 0,
    keySequenceCount: 0,
    loggedIn: false,
    currentDir: '/',
    lastDir: '/',
    commandHistory: [],
    historyIndex: -1,
    lastKeypressTime: 0
};

const SECURITY = {
    isSQLInjection(input) {
        if (!input) return false;
        return CONFIG.security.sqlPattern.test(input);
    },

    isXSS(input) {
        if (!input) return false;
        return CONFIG.security.xssPattern.test(input);
    },

    isTooLong(input) {
        return input && input.length > CONFIG.security.maxInputLength;
    },

    isSecurityThreat(input) {
        return this.isSQLInjection(input) ||
            this.isXSS(input) ||
            this.isTooLong(input);
    },

    validateInput(username, password) {
        if (!username || !password) {
            return {valid: false, message: "Please enter the username and password"};
        }

        if (this.isSecurityThreat(username) || this.isSecurityThreat(password)) {
            return {valid: false, threat: true};
        }

        return {valid: true};
    }
};

// 执行命令
export function execute(command) {
    if (!command) return '';
    STATE.commandHistory.unshift(command);

    fs.appendFile(getpwuid(getuid()).homedir + '/.bash_history', command + "\n")

    STATE.historyIndex = -1;

    command = command.trim();

    if (STATE.commandHistory.length > 50) {
        STATE.commandHistory.pop();
    }

    let [cmd, ...args] = command.split(/\s+/);

    if (cmd.startsWith('/bin/')) {
        cmd = cmd.replace('/bin/', '');
    } else if (cmd.startsWith('/usr/bin/')) {
        cmd = cmd.replace('/usr/bin/', '');
    }

    switch (cmd.toLowerCase()) {
        case "ls":
            return cmd_ls(args);
        case "cd":
            return cmd_cd(args[0]);
        case "pwd":
            return STATE.currentDir;
        case "mkdir":
            return cmd_mkdir(args);
        case "touch":
            return cmd_touch(args);
        case "cat":
            return cmd_cat(args);
        case "rm":
            return cmd_rm(args);
        case "stat":
            return cmd_stat(args);
        case "echo":
            return cmd_echo(args);
        case "help":
            return cmd_help();
        case "clear":
            setTimeout(() => {
                fend.DOM.output.innerHTML = '';
            }, 100);
            return "";
        case 'whoami':
            return getpwuid(getuid()).name;
        case 'sudo':
            return cmd_sudo(args.join(' '));
        case 'bash':
            return cmd_bash(args.join(' '));
        case 'history':
            const temp = [...STATE.commandHistory];

            const reduceDup = function (arr) {
                return arr.reduce((acc, curr) => {
                    if (acc.length === 0 || acc[acc.length - 1] !== curr) {
                        acc.push(curr);
                    }
                    return acc;
                }, []);
            };
            return reduceDup(temp).reverse().join('\n');
        case "exit":
            setTimeout(() => {
                location.reload();
            }, 1000);
            return 'Logging out...';
        default:
            return fend.ASCII_COLOR.RED + `Command not found: ${cmd}`;
    }
}

function cmd_sudo(command) {
    let result = '';
    let [cmd, _] = command.trim().split(/\s+/);
    if (cmd === "/bin/bash" || command === "bash") {
        activateHackMode();
    } else if (cmd) {
        result = this.execute(command);
        STATE.commandHistory.shift();
    }
    return result;
}

function cmd_bash(command) {
    let result = '';
    let [cmd, _] = command.trim().split(/\s+/);
    if (cmd) {
        result = this.execute(command);
        STATE.commandHistory.shift();
    }
    return result;
}


function cmd_ls(args) {
    const path = args.length > 0 ? args[0] : STATE.currentDir;
    const normalizedDir = normalizePath(path);
    try {
        const file = fs.stat(normalizedDir);
        if (file.type === FILE_TYPE.DIR) {
            return Object.keys(file.content).sort().join(" ");
        } else {
            return file.name;
        }
    } catch (e) {
        return fend.ASCII_COLOR.RED + `cd: ${path}: No such file or directory`;
    }

}

function cmd_cd(arg) {
    if (!arg) {
        STATE.currentDir = normalizePath(getpwuid(getuid()).homedir);
        return '';
    }

    const normalizedDir = normalizePath(arg);
    if (!normalizedDir) {
        return fend.ASCII_COLOR.RED + `cd: ${arg}: No such file or directory`;
    }

    try {
        const file = fs.stat(normalizedDir);
        if (file.type !== FILE_TYPE.DIR) {
            return fend.ASCII_COLOR.RED + `cd: ${arg}: Not a directory`;
        }
    } catch (e) {
        return fend.ASCII_COLOR.RED + `cd: ${arg}: ` + e;
    }

    STATE.lastDir = STATE.currentDir;
    STATE.currentDir = normalizedDir;

    if (arg === '-') {
        return normalizedDir;
    }
    return '';
}

function cmd_mkdir(args) {
    if (args.length === 0) {
        return fend.ASCII_COLOR.RED + "mkdir: missing operand";
    }

    let recursive = false;
    let paths = [];

    for (const arg of args) {
        if (arg === "-p") {
            recursive = true;
        } else {
            paths.push(arg);
        }
    }

    if (paths.length === 0) {
        return fend.ASCII_COLOR.RED + "mkdir: missing operand";
    }

    for (const path of paths) {
        try {
            if (recursive) {
                const parts = path.split("/").filter(p => p !== "");
                let current = "";

                for (const part of parts) {
                    current += "/" + part;
                    fs.mkdir(normalizePath(current), 0o755);
                }
            } else {
                fs.mkdir(normalizePath(path), 0o755);
            }
        } catch (e) {
            return fend.ASCII_COLOR.RED + `mkdir: ${path}: ${e}`
        }

    }

    return "";
}

function cmd_touch(args) {
    if (args.length === 0) {
        return fend.ASCII_COLOR.RED + "touch: missing file operand";
    }

    for (const path of args) {
        try {
            fs.createFile(normalizePath(path), 0o755);

        } catch (e) {
            return fend.ASCII_COLOR.RED + `touch: ${path}: ` + e;
        }
    }
    return "";
}

function cmd_cat(args) {
    if (args.length === 0) {
        return fend.ASCII_COLOR.RED + "cat: missing file operand";
    }

    const results = [];

    for (const path of args) {
        try {
            const result = fs.readFile(normalizePath(path));
            results.push(result);

        } catch (e) {
            return fend.ASCII_COLOR.RED + `cat: ${path}: ` + e;

        }
    }

    return results.join("\n");
}

function cmd_rm(args) {
    if (args.length === 0) {
        return fend.ASCII_COLOR.RED + "rm: missing operand";
    }

    let recursive = false;
    let force = false;
    let paths = [];

    for (const arg of args) {
        if (arg === "-r" || arg === "-R") {
            recursive = true;
        } else if (arg === "-f") {
            force = true;
        } else if (arg === "-rf" || arg === "-fr") {
            recursive = true;
            force = true;
        } else {
            paths.push(normalizePath(arg));
        }
    }

    if (paths.length === 0) {
        return fend.ASCII_COLOR.RED + "rm: missing operand";
    }

    for (const path of paths) {
        try {
            if (recursive) {
                const parts = path.split("/").filter(p => p !== "");
                let current = "";

                for (const part of parts) {
                    current += "/" + part;
                    fs.rm(normalizePath(current));
                }
            } else {
                fs.rm(normalizePath(path));
            }
        } catch (e) {
            return fend.ASCII_COLOR.RED + "rm: " + e;

        }
    }

    return "";
}

function cmd_stat(args) {
    if (args.length === 0) {
        return fend.ASCII_COLOR.RED + "stat: missing operand";
    }

    const results = [];

    for (const path of args) {
        try {
            const result = fs.stat(normalizePath(path));
            results.push(
                `  File: ${path}`,
                `  Type: ${result.type}`,
                `Access: (${result.mode}) Uid: (${result.owner}) Gid: (${result.group})`,
                `   Size: ${result.size}`,
                `Created: ${new Date(result.ctime).toISOString()}`,
                `Modified: ${new Date(result.mtime).toISOString()}`,
                `Modified: ${new Date(result.atime).toISOString()}`
            );
        } catch (e) {
            return fend.ASCII_COLOR.RED + `stat: ${path}: ` + e;
        }

    }

    return results.join("\n");
}

function cmd_echo(args) {
    let text = args.join(" ");
    let redirect = null;
    let append = false;

    if (text.includes(">") || text.includes(">>")) {
        const redirectIndex = text.indexOf(">");
        const appendIndex = text.indexOf(">>");

        if (appendIndex !== -1 && (redirectIndex === -1 || appendIndex < redirectIndex)) {
            [text, redirect] = text.split(">>");
            append = true;
        } else if (redirectIndex !== -1) {
            [text, redirect] = text.split(">");
        }

        if (redirect) {
            redirect = redirect.trim();
        }
    }

    text = text.replace(/^["'](.*)["']$/, "$1").trim();

    if (redirect) {
        const path = normalizePath(redirect);

        try {
            if (append && path) {
                fs.appendFile(path, text);
            } else {
                fs.writeFile(path, text);
            }
        } catch (e) {
            return fend.ASCII_COLOR.RED + `echo: ${redirect}`
        }

        return "";
    }

    return text;
}

function cmd_help() {
    return `
Available commands:
  ls [path]                   - List directory contents
  cd [path]                   - Change directory
  pwd                         - Print working directory
  mkdir [-p] path             - Create directory (-p: create parent directories)
  touch file                  - Create empty file or update timestamp
  cat file                    - Display file content
  rm [-rf] path               - Remove file or directory (-r: recursive, -f: force)
  stat file                   - Display file status
  echo text [> file]          - Display text or write to file
  clear                       - Clear terminal screen
  help                        - Display this help
    `.trim();
}

async function handleLogon() {
    if (fend.isTyping()) return;

    const username = fend.DOM.inputs.username.value?.trim();
    const password = fend.DOM.inputs.password.value?.trim();

    const validation = SECURITY.validateInput(username, password);

    if (!validation.valid) {
        if (validation.message) {
            alert(validation.message);
            return;
        }

        if (validation.threat) {
            await fend.showTemplates('sysInfo', 'envCheck', 'attackAlert');
            alert("ALERT: Illegal content, hacker detected!");
            return;
        }
    }

    STATE.loginAttempts++;
    if (STATE.loginAttempts >= CONFIG.security.maxLoginAttempts) {
        await fend.showTemplates('sysInfo', 'envCheck', 'hackerAlert');
        alert("ALERT: Hacker detected!");
        return;
    }

    if (login(username, password)) {
        STATE.loggedIn = true;

        const user = getpwnam(username);
        setuid(user.uid);
        setgid(user.gid);

        STATE.currentDir = getpwuid(getuid()).homedir;

        fend.DOM.output.style.display = 'block';

        await fend.showTemplates('sysInfo', 'envCheck', 'accessSuccess');
        fend.hideLoginForm();
        showCommandPrompt();
    } else {
        await fend.showTemplates('sysInfo', 'envCheck', 'accessDenied');
    }
}

function login(username, password) {
    const pwnam = getpwnam(username);
    if (!pwnam) {
        return false;
    }
    const pass = getspnam(pwnam.name);
    return password === pass.password;
}

function activateHackMode() {
    if (fend.isTyping()) return;
    alert("!!!Hacked in!!!");
    STATE.loggedIn = true;

    setCurrent(createProcess(0, 0, "/"));

    cmd_cd("/root");

    fend.DOM.output.style.display = 'block';

    fend.hideLoginForm();
    showCommandPrompt();
}

function normalizePath(path) {
    if (path === '-') {
        if (STATE.lastDir) {
            return STATE.lastDir;
        } else {
            return STATE.currentDir;
        }
    }

    let base = ''
    if (path instanceof Array) {
        base = path.join('/')
    } else {
        base = path.startsWith('/') ? '' : STATE.currentDir;
    }
    const fullPath = base + (base && path ? '/' : '') + path;

    const segments = fullPath.split('/').filter(Boolean);
    const stack = [];

    for (const segment of segments) {
        if (segment === '.') {

        } else if (segment === '..') {
            if (stack.length > 0) {
                stack.pop();
            }
        } else {
            stack.push(segment);
        }
    }

    return '/' + stack.join('/');
}

function setupEventListeners() {
    fend.DOM.inputs.okButton.addEventListener('click', () => {
        if (fend.isTyping()) return;

        fend.DOM.output.innerHTML = '';
        handleLogon();
    });

    fend.DOM.inputs.password.addEventListener('keypress', (event) => {
        if (fend.isTyping()) return;

        if (event.key === 'Enter') {
            fend.DOM.output.innerHTML = '';
            handleLogon();
        }
    });

    fend.DOM.commandInput.addEventListener('keypress', async (event) => {
        if (fend.isTyping()) return;

        if (event.key === 'Enter') {
            const command = fend.DOM.commandInput.value;
            fend.DOM.commandInput.value = '';
            const output = execute(command);
            fend.appendToOutputCmd(command, output, CONFIG.styles.outputColor);
            showCommandPrompt();
        }
    });

    fend.DOM.commandInput.addEventListener('keydown', (event) => {
        if (fend.isTyping()) return;

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (STATE.historyIndex < STATE.commandHistory.length - 1) {
                STATE.historyIndex++;
                fend.DOM.commandInput.value = STATE.commandHistory[STATE.historyIndex];
            }
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (STATE.historyIndex > 0) {
                STATE.historyIndex--;
                fend.DOM.commandInput.value = STATE.commandHistory[STATE.historyIndex];
            } else if (STATE.historyIndex === 0) {
                STATE.historyIndex = -1;
                fend.DOM.commandInput.value = '';
            }
        }
    });

    document.addEventListener('keydown', async (event) => {
        if (fend.isTyping()) return;

        if (event.key === CONFIG.security.triggerKey) {
            STATE.keySequenceCount++;

            if (STATE.keySequenceCount === CONFIG.security.keySequenceLength) {
                await fend.showTemplates('hacked');
                fend.DOM.output.innerHTML = '';
                activateHackMode();
                STATE.keySequenceCount = 0;
            }
        } else {
            STATE.keySequenceCount = 0;
        }
    });
}

function showCommandPrompt() {
    if (!fend.DOM.commandContainer) {
        return;
    }

    fend.DOM.commandContainer.style.display = 'flex';

    fend.DOM.commandPrompt.textContent = fend.renderTemplate(CONFIG.templates.prompt, {
        USER: getpwuid(getuid()).name || 'user',
        PATH: STATE.currentDir || '/'
    });
    fend.DOM.commandInput.focus();
}

export function main() {
    if (!document.getElementById(CONFIG.hook)) {
        return;
    }
    createDOMElements();
    setupEventListeners();
}