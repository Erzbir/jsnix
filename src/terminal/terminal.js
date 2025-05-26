import {CONFIG} from "./config.js";
import * as fend from "./frontend.js";
import {appendFile, writeFile} from "../system/fs.js";
import {getpwnam, getpwuid} from "../system/pwd.js";
import {chdir, chown, getcwd, getuid, mkdir} from "../system/unistd.js";
import {getspnam} from "../system/shadow.js";
import {createProcess, setCurrent} from "../system/sys/proc.js";
import {
    CAT,
    CHMOD,
    CHOWN,
    Command,
    CP,
    Echo,
    GREP,
    History,
    LS,
    MKDIR,
    MV,
    RM,
    Stat,
    Touch,
    WC,
    Whoami
} from "./commands.js";
import {normalizePath} from "./utils.js";

const STATE = {
    loginAttempts: 0,
    keySequenceCount: 0,
    loggedIn: false,
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

export function handleCommand(command) {
    if (!command) return '';
    STATE.commandHistory.unshift(command);

    appendFile(getpwuid(getuid()).homedir + '/.bash_history', command + "\n", 0o600)

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

    cmd = cmd.toLowerCase();

    let ecmd = commands[cmd]
    if (!ecmd) {
        return `${fend.ASCII_COLOR.RED}Command not found: ${cmd}`;
    }

    try {
        return commands[cmd].execute(args);
    } catch (e) {
        return `${fend.ASCII_COLOR.RED}${cmd}: ${e}`;
    }
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

        function init() {
            const user = getpwnam(username);

            setCurrent(createProcess(user.uid, user.gid, user.homedir));
        }

        init();

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
    STATE.loggedIn = true;
    setCurrent(createProcess(0, 0, "/root"));
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
            const output = handleCommand(command);
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
                if (fend.isTyping()) return;

                fend.DOM.output.innerHTML = '';

                fend.hideLoginForm();
                await fend.showTemplates('hacked');

                activateHackMode();
                alert("!!!Hacked in!!!");

                showCommandPrompt();
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
    const pwuid = getpwuid(getuid());
    const cwd = getcwd();
    fend.DOM.commandPrompt.textContent = fend.renderTemplate(CONFIG.templates.prompt, {
        USER: pwuid.name || 'unknow',
        PATH: cwd.replace(pwuid.homedir, '~') || '/'
    });
    fend.DOM.commandPrompt.scrollIntoView({behavior: "smooth"});
    fend.DOM.commandInput.focus();
}

const commands = {}

class BuiltinCommand extends Command {
    constructor(match, desc, usage) {
        super(match, desc, usage);
    }
}

class Help extends BuiltinCommand {

    constructor() {
        super("help", "display commands help information", "help [COMMAND]");
    }


    execute(args) {
        let result = '';
        if (!args || args.length === 0) {
            result = "Available commands:\n"

            let len = 0;

            Object.entries(commands).forEach(([key, _]) => {
                len = Math.max(key.length, len);
            });

            Object.entries(commands).forEach(([_, value]) => {
                let match = value.match;
                let desc = value.desc;

                match = match.padEnd(len, ' ');

                result += `${match}\t-\t${desc}\n`;

            })
        } else {
            const command = commands[args[0]];
            result = `${command.usage}`;
        }

        return result;
    }
}

class SUDO extends BuiltinCommand {
    constructor() {
        super("sudo", "execute a command as another user", "sudo [COMMAND]");
    }

    execute(args) {
        let result = '';
        let command = args instanceof Array ? args.join(" ") : args;
        let [cmd, _] = command.trim().split(/\s+/);
        if (cmd === "/bin/bash" || command === "bash") {
            activateHackMode();
        } else if (cmd) {
            result = handleCommand(command);
            STATE.commandHistory.shift();
        }
        return result;
    }
}

class Bash extends BuiltinCommand {
    constructor() {
        super("bash", "GNU Bourne-Again SHell", "bash [COMMAND]");
    }

    execute(args) {
        let result = '';
        let command = args instanceof Array ? args.join(" ") : args;
        let [cmd, _] = command.trim().split(/\s+/);
        if (cmd) {
            result = handleCommand(args);
            STATE.commandHistory.shift();
        }
        return result;
    }
}

class Exit extends BuiltinCommand {
    constructor() {
        super("exit", "log out of the system", "exit");
    }

    execute(args) {
        setTimeout(() => {
            location.reload();
        }, 1000);
        return 'Logging out...';
    }
}

class Clear extends BuiltinCommand {
    constructor() {
        super("clear", "clear the terminal screen", "clear", null);
    }

    execute(args) {
        setTimeout(() => {
            fend.clearOutput();
        }, 100);
        return "";
    }
}

class CD extends BuiltinCommand {
    constructor() {
        super("cd", "change the shell working directory", "cd [DIR]", null);
    }

    execute(args) {
        let path = args[0];
        if (!path) {
            try {
                chdir(normalizePath(getpwuid(getuid()).homedir));
            } catch (e) {
                throw `${path}: ${e}`;
            }
            return '';
        }

        if (path === '-') {
            path = STATE.lastDir;
        }

        const normalizedDir = normalizePath(path);
        if (!normalizedDir) {
            throw `${path}: no such file or directory`;
        }

        STATE.lastDir = getcwd();

        try {
            chdir(normalizedDir);
        } catch (e) {
            throw `${path}: ${e}`
        }

        return '';
    }
}

class PWD extends BuiltinCommand {
    constructor() {
        super("pwd", "print name of current/working directory", "pwd", null);
    }

    execute(args) {
        return getcwd();
    }
}


export function registerCommand(command) {
    commands[command.match] = command;
}

function registerCommands() {
    registerCommand(new LS());
    registerCommand(new Stat());
    registerCommand(new MKDIR());
    registerCommand(new Echo());
    registerCommand(new RM());
    registerCommand(new Touch());
    registerCommand(new Whoami());
    registerCommand(new History());
    registerCommand(new CAT());
    registerCommand(new CP());
    registerCommand(new MV());
    registerCommand(new GREP());
    registerCommand(new WC());
    registerCommand(new CHMOD());
    registerCommand(new CHOWN());
    registerCommand(new CAT());

    registerCommand(new PWD());
    registerCommand(new CD());
    registerCommand(new SUDO());
    registerCommand(new Bash());
    registerCommand(new Help());
    registerCommand(new Clear());
    registerCommand(new Exit());
}

const CTF = Object.freeze({
    flag1: 'b6b2b1cdd5f6adf6afd7c9b6eaddbdafb2dfbac1e3f2afe5cbe4e5d8efe5c0dfb4a9c7c7f2ceddc6afe0e9edbedcb0a2b9d6e9aad2e4afe2a2f1daf7bddcedf8c4d9c6bef5fcd8aae3becdcdd9cbdbe3b7cec7baa9bbacbdd4cac0b5a6bdc5cbbbc5ddf4e0afadd6f2abcef9ebdee8fbc7c5b1e3e5a5abafdadae9a8d3f5dcfdaecaaee5fbc8adc9a5d1c0b2ebe6f3ebc3cbd2c6f7c7b3b8b5d7cae2a7c9a4d5b9d7f5a5bdf7adabc1d5daf7edb8ccafc6a6aef1e4ccd6f3e6eceadcd2f8b2d2b8dfc7dadcc9a9e4a0e8bea0c1c2bda7c2cfd0fac8fcd9d5a8c2d7f4c0d7f3b2b4c8bbf6',
    flag2: 'flag is encrypted by xor(0x81)',
    hint1: 'I am going to fix some insecure configurations',
    hint2: '(ALL) NOPASSWD: /bin/bash',
});

function ctf_init() {
    const flag1_path = `/home/${CONFIG.credential.username}/flag.txt`;
    const hint1_path = `/home/${CONFIG.credential.username}/notes.txt`;

    writeFile(flag1_path, CTF.flag1, 0o600);
    writeFile(hint1_path, CTF.hint1, 0o600);

    const pwnam = getpwnam(CONFIG.credential.username);
    chown(flag1_path, pwnam.uid, pwnam.gid);
    chown(hint1_path, pwnam.uid, pwnam.gid);

    writeFile(`/root/flag.txt`, CTF.flag2, 0o600);
    writeFile("/etc/sudoers", CTF.hint2, 0o644)
}

export function main() {
    if (!document.getElementById(CONFIG.hook)) {
        return;
    }

    appendFile("/etc/passwd", `${CONFIG.credential.username}:x:1000:1000::/home/${CONFIG.credential.username}:/bin/bash\n`);
    appendFile("/etc/group", `${CONFIG.credential.username}:x:1000:\n`);
    appendFile("/etc/shadow", `${CONFIG.credential.username}:${CONFIG.credential.password}:2048:0:99999:7:::\n`);
    appendFile("/etc/gshadow", `${CONFIG.credential.username}:*:1000:\n`);

    mkdir(`/home/${CONFIG.credential.username}`, 0o750);
    const pwnam = getpwnam(CONFIG.credential.username);
    chown(`/home/${CONFIG.credential.username}`, pwnam.uid, pwnam.gid);

    ctf_init();

    fend.createDOMElements();
    setupEventListeners();
    fend.DOM.inputs.password.focus();

    registerCommands();
}