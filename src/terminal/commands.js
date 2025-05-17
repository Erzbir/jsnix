import {appendFile, createFile, FILE_TYPE, mkdir, readFile, rm, stat, writeFile} from "../system/fs.js";
import {normalizePath} from "./utils.js";
import {getpwuid} from "../system/pwd.js";
import {getcwd, getuid} from "../system/unistd.js";

export class Command {
    /**
     *
     * @param {string} match
     * @param {string} desc
     * @param {string} usage
     */
    constructor(match, desc, usage) {
        this.match = match;
        this.desc = desc;
        this.usage = usage;
    }

    /**
     *
     * @param {string[]} args
     * @returns {string}
     */
    execute(args) {
        throw new Error("Not implement");
    }

    help() {
        return `${this.desc} - ${this.usage}`;
    }
}

export class LS extends Command {
    constructor() {
        super("ls", "ls", "ls");
    }


    execute(args) {
        const path = args.length > 0 ? args[0] : getcwd();
        const normalizedDir = normalizePath(path);
        try {
            const file = stat(normalizedDir);
            if (file.type === FILE_TYPE.DIR) {
                return Object.keys(file.content).sort().join(" ");
            } else {
                return file.name;
            }
        } catch (e) {
            throw `${path}: ${e}`
        }
    }
}

export class MKDIR extends Command {
    constructor() {
        super("mkdir", "mkdir", "mkdir");
    }

    execute(args) {
        if (args.length === 0) {
            throw "missing operand";
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
            throw "missing operand";
        }

        for (const path of paths) {
            try {
                if (recursive) {
                    const parts = path.split("/").filter(p => p !== "");
                    let current = "";

                    for (const part of parts) {
                        current += "/" + part;
                        mkdir(normalizePath(current), 0o755);
                    }
                } else {
                    mkdir(normalizePath(path), 0o755);
                }
            } catch (e) {
                throw `${path}: ${e}`
            }
        }

        return "";
    }
}

export class Touch extends Command {
    constructor() {
        super("touch", "touch", "touch");
    }

    execute(args) {
        if (args.length === 0) {
            throw "missing file operand";
        }

        for (const path of args) {
            try {
                createFile(normalizePath(path), 0o755);

            } catch (e) {
                throw `${path}: ${e}`
            }
        }
        return "";
    }
}

export class RM extends Command {
    constructor() {
        super("rm", "rm", "rm");
    }

    execute(args) {
        if (args.length === 0) {
            throw "missing operand";
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
            throw "missing operand";
        }

        for (const path of paths) {
            try {
                if (recursive) {
                    const parts = path.split("/").filter(p => p !== "");
                    let current = "";

                    for (const part of parts) {
                        current += "/" + part;
                        rm(normalizePath(current));
                    }
                } else {
                    rm(normalizePath(path));
                }
            } catch (e) {
                throw `${path}: ${e}`
            }
        }

        return "";
    }
}

export class Stat extends Command {
    constructor() {
        super("stat", "stat", "stat");
    }

    execute(args) {
        if (args.length === 0) {
            throw "missing operand";
        }

        const results = [];

        for (const path of args) {
            try {
                const result = stat(normalizePath(path));
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
                throw `${path}: ${e}`
            }

        }

        return results.join("\n");
    }
}

export class Echo extends Command {
    constructor() {
        super("echo", "echo", "echo");
    }

    execute(args) {
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
        } else {
            return args;
        }

        text = text.replace(/^["'](.*)["']$/, "$1").trim();

        if (redirect) {
            const path = normalizePath(redirect);

            try {
                if (append && path) {
                    appendFile(path, text);
                } else {
                    writeFile(path, text);
                }
            } catch (e) {
                throw `${redirect}: ${e}`;
            }

            return "";
        }

        return text;
    }
}

export class Whoami extends Command {
    constructor() {
        super("whoami", "whoami", "whoami");
    }

    execute(args) {
        return getpwuid(getuid()).name;
    }
}

export class History extends Command {
    constructor() {
        super("history", "history", "history");
    }

    execute(args) {
        const temp = [...(readFile(`${getpwuid(getuid()).homedir}/.bash_history`)).split("\n")];

        const reduceDup = function (arr) {
            return arr.reduce((acc, curr) => {
                if (acc.length === 0 || acc[acc.length - 1] !== curr) {
                    acc.push(curr);
                }
                return acc;
            }, []);
        };
        return reduceDup(temp).reverse().join('\n');
    }
}

export class CAT extends Command {
    constructor() {
        super("cat", "cat", "cat");
    }

    execute(args) {
        if (!args || args.length === 0) {
            throw 'missing file operand';
        }

        let result = '';

        for (const path of args) {
            try {
                const content = readFile(normalizePath(path));
                result += content;
            } catch (e) {
                throw `${path}: ${e}`;
            }
        }
        return result;
    }
}
