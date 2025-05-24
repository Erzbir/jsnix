import {appendFile, createFile, FILE_TYPE, mkdir, readFile, rm, rmdir, stat, unlink, writeFile} from "../system/fs.js";
import {normalizePath} from "./utils.js";
import {getpwnam, getpwuid} from "../system/pwd.js";
import {chmod, chown, getcwd, getuid} from "../system/unistd.js";
import {getgrgid, getgrnam} from "../system/grp.js";

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
        super("ls", "list directory contents", "ls [-a|l|h|t|r|d] [DIR]");
    }


    execute(args) {
        let showAll = false;        // -a
        let longFormat = false;     // -l
        let recursive = false;      // -R
        let humanReadable = false;  // -h
        let sortByTime = false;     // -t
        let reverseOrder = false;   // -r
        let onlyDirs = false;       // -d
        let paths = [];

        for (const arg of args) {
            if (arg.startsWith("-")) {
                for (let i = 1; i < arg.length; i++) {
                    const option = arg[i];
                    switch (option) {
                        case 'a':
                            showAll = true;
                            break;
                        case 'l':
                            longFormat = true;
                            break;
                        case 'R':
                            recursive = true;
                            break;
                        case 'h':
                            humanReadable = true;
                            break;
                        case 't':
                            sortByTime = true;
                            break;
                        case 'r':
                            reverseOrder = true;
                            break;
                        case 'd':
                            onlyDirs = true;
                            break;
                        default:
                            throw `invalid option -- '${option}'`;
                    }
                }
            } else {
                paths.push(arg);
            }
        }

        if (paths.length === 0) {
            paths.push(getcwd());
        }

        const results = [];
        const normalizedPaths = paths.map(path => normalizePath(path));

        const showPathName = normalizedPaths.length > 1;

        for (const path of normalizedPaths) {
            try {
                const file = stat(path);

                if (file.type === FILE_TYPE.DIR && !onlyDirs) {
                    if (showPathName) {
                        results.push(`${path}:`);
                    }

                    const entries = Object.entries(file.content).map(([name, entry]) => {
                        return {
                            name,
                            ...entry
                        };
                    });

                    const filteredEntries = showAll
                        ? entries
                        : entries.filter(entry => !entry.name.startsWith('.'));

                    let sortedEntries = [...filteredEntries];
                    if (sortByTime) {
                        sortedEntries.sort((a, b) => b.mtime - a.mtime); // 按修改时间降序
                    } else {
                        sortedEntries.sort((a, b) => a.name.localeCompare(b.name)); // 按名称升序
                    }

                    if (reverseOrder) {
                        sortedEntries.reverse();
                    }

                    if (longFormat) {
                        for (const entry of sortedEntries) {
                            results.push(this._formatLongEntry(path, entry, humanReadable));
                        }
                    } else {
                        const names = sortedEntries.map(entry => {
                            let prefix = "";
                            return prefix + entry.name;
                        });
                        results.push(names.join("  "));
                    }

                    if (recursive) {
                        for (const entry of sortedEntries) {
                            if (entry.type === FILE_TYPE.DIR && entry.name !== '.' && entry.name !== '..') {
                                results.push('');
                                results.push(`${path}/${entry.name}:`);
                                const subResults = this.execute([
                                    ...(showAll ? ['-a'] : []),
                                    ...(longFormat ? ['-l'] : []),
                                    ...(humanReadable ? ['-h'] : []),
                                    ...(sortByTime ? ['-t'] : []),
                                    ...(reverseOrder ? ['-r'] : []),
                                    `${path}/${entry.name}`
                                ]);
                                results.push(subResults);
                            }
                        }
                    }
                } else {
                    if (longFormat) {
                        results.push(this._formatLongEntry(path, {
                            ...file,
                            name: path.split('/').pop()
                        }, humanReadable));
                    } else {
                        let result = "";
                        result += path.split('/').pop();
                        results.push(result);
                    }
                }
            } catch (e) {
                throw `'${path}': ${e}`;
            }

            if (showPathName && normalizedPaths.indexOf(path) !== normalizedPaths.length - 1) {
                results.push('');
            }
        }

        return results.join("\n");
    }

    _formatLongEntry(path, entry, humanReadable) {
        let typeChar = '-';
        if (entry.type === FILE_TYPE.DIR) {
            typeChar = 'd';
        }

        const mode = entry.mode || 0;
        const permissions = this._formatPermissions(mode);

        const links = entry.links || 1;

        const owner = getpwuid(entry.owner).name || '?';
        const group = getgrgid(entry.group).name || '?';

        let size;
        if (humanReadable) {
            size = this._humanReadableSize(entry.size || 0);
        } else {
            size = entry.size || 0;
        }

        const mtime = new Date(entry.mtime || Date.now());
        const timeStr = this._formatTime(mtime);

        const name = entry.name;

        let result = '';

        result += `${typeChar}${permissions}\t${links}\t${owner}\t${group}\t${size.toString().padStart(8)}\t${timeStr}\t${name}`;

        return result;
    }

    _formatPermissions(mode) {
        const user = [
            (mode & 0o400) ? 'r' : '-',
            (mode & 0o200) ? 'w' : '-',
            (mode & 0o100) ? 'x' : '-'
        ];

        const group = [
            (mode & 0o040) ? 'r' : '-',
            (mode & 0o020) ? 'w' : '-',
            (mode & 0o010) ? 'x' : '-'
        ];

        const others = [
            (mode & 0o004) ? 'r' : '-',
            (mode & 0o002) ? 'w' : '-',
            (mode & 0o001) ? 'x' : '-'
        ];

        return user.join('') + group.join('') + others.join('');
    }

    _humanReadableSize(size) {
        const units = ['B', 'K', 'M', 'G', 'T', 'P'];
        let unitIndex = 0;
        let scaledSize = size;

        while (scaledSize >= 1024 && unitIndex < units.length - 1) {
            unitIndex += 1;
            scaledSize /= 1024;
        }

        if (unitIndex === 0) {
            return `${scaledSize}${units[unitIndex]}`;
        } else {
            return `${scaledSize.toFixed(1)}${units[unitIndex]}`;
        }
    }

    _formatTime(date) {
        const now = new Date();
        const sixMonthsAgo = new Date(now);
        sixMonthsAgo.setMonth(now.getMonth() - 6);

        const months = [
            'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
        ];

        const month = months[date.getMonth()];
        const day = date.getDate().toString().padStart(2, ' ');

        let timeOrYear;
        if (date > sixMonthsAgo) {
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            timeOrYear = `${hours}:${minutes}`;
        } else {
            timeOrYear = date.getFullYear();
        }

        return `${month} ${day} ${timeOrYear}`;
    }
}

export class MKDIR extends Command {
    constructor() {
        super("mkdir", "make directories", "mkdir [-p] DIR");
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
                        mkdir(normalizePath(current));
                    }
                } else {
                    mkdir(normalizePath(path));
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
        super("touch", "change file access and modification times", "touch FILE...");
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
        super("rm", "remove directory entries", "rm [-r|R|f] FILE");
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
                    this._rmRecursive(path, force);
                } else {
                    this._rmSingle(path, force);
                }
            } catch (e) {
                if (!force) {
                    throw `${path}: ${e}`;
                }
            }
        }

        return "";
    }

    _rmRecursive(path, force) {
        try {
            const fileInfo = stat(path);

            if (fileInfo.type === FILE_TYPE.DIR) {
                const dirContent = fileInfo.content;

                for (const item in dirContent) {
                    if (item === "." || item === "..") {
                        continue;
                    }

                    const itemPath = path === '/' ? `/${item}` : `${path}/${item}`;
                    this._rmRecursive(itemPath, force);
                }
            }

            rm(path);
        } catch (e) {
            if (!force) {
                throw e;
            }
        }
    }

    _rmSingle(path, force) {
        try {
            const fileInfo = stat(path);

            if (fileInfo.type === FILE_TYPE.DIR) {
                const dirContent = fileInfo.content;

                const realContentCount = Object.keys(dirContent).filter(item => item !== "." && item !== "..").length;

                if (realContentCount > 0 && !force) {
                    throw "directory not empty";
                }
            }

            rm(path);
        } catch (e) {
            if (!force) {
                throw e;
            }
        }
    }
}

export class Stat extends Command {
    constructor() {
        super("stat", "display file status", "stat FILE...");
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
        super("echo", "write arguments to the standard output", "echo [string]");
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
        super("whoami", "display effective user id", "whoami");
    }

    execute(args) {
        return getpwuid(getuid()).name;
    }
}

export class History extends Command {
    constructor() {
        super("history", "print commands history", "history");
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
        super("cat", "concatenate files and print on the standard output", "cat FILE...");
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

export class CP extends Command {
    constructor() {
        super("cp", "cp", "cp [-r|R|f] SOURCE DEST");
    }

    execute(args) {
        if (args.length < 2) {
            throw "missing file operand";
        }

        let recursive = false;
        let force = false;
        let sources = [];
        let destination = null;

        for (const arg of args) {
            if (arg === "-r" || arg === "-R") {
                recursive = true;
            } else if (arg === "-f") {
                force = true;
            } else {
                if (destination === null && sources.length > 0) {
                    destination = arg;
                } else {
                    sources.push(arg);
                }
            }
        }

        if (destination === null) {
            destination = sources.pop();
            if (sources.length === 0) {
                throw "missing destination file operand";
            }
        }

        destination = normalizePath(destination);
        sources = sources.map(src => normalizePath(src));

        let isDestDir;
        try {
            const destStat = stat(destination);
            isDestDir = destStat.type === FILE_TYPE.DIR;
        } catch (e) {
            isDestDir = false;
        }

        if (sources.length > 1 && !isDestDir) {
            throw `'${destination}': is not a directory`;
        }

        for (const source of sources) {
            try {
                const sourceStat = stat(source);

                let destPath = destination;
                if (isDestDir) {
                    const sourcePathParts = source.split('/');
                    const sourceFileName = sourcePathParts[sourcePathParts.length - 1];
                    destPath = `${destination}/${sourceFileName}`;
                }

                if (sourceStat.type === FILE_TYPE.DIR) {
                    if (!recursive) {
                        throw `${source}: is a directory`;
                    }

                    try {
                        mkdir(destPath, sourceStat.mode);
                    } catch (e) {
                        if (!force || !e.includes("exist")) {
                            throw e;
                        }
                    }

                    const files = Object.keys(sourceStat.content);
                    for (const file of files) {
                        const subSource = `${source}/${file}`;
                        const subDest = `${destPath}/${file}`;

                        this.execute(["-r", subSource, subDest]);
                    }
                } else {
                    const content = readFile(source);
                    writeFile(destPath, content);
                }
            } catch (e) {
                throw `${source}: ${e}`;
            }
        }

        return "";
    }
}

export class MV extends Command {
    constructor() {
        super("mv", "move (rename) files", "mv [-f] SOURCE DEST");
    }

    execute(args) {
        if (args.length < 2) {
            throw "missing file operand";
        }

        let force = false;
        let sources = [];
        let destination = null;

        for (const arg of args) {
            if (arg === "-f") {
                force = true;
            } else {
                if (destination === null && sources.length > 0) {
                    destination = arg;
                } else {
                    sources.push(arg);
                }
            }
        }

        if (destination === null) {
            destination = sources.pop();
            if (sources.length === 0) {
                throw "missing destination file operand";
            }
        }

        destination = normalizePath(destination);
        sources = sources.map(src => normalizePath(src));

        let isDestDir;
        try {
            const destStat = stat(destination);
            isDestDir = destStat.type === FILE_TYPE.DIR;
        } catch (e) {
            isDestDir = false;
        }

        if (sources.length > 1 && !isDestDir) {
            throw `'${destination}': is not a directory`;
        }

        for (const source of sources) {
            try {
                const sourceStat = stat(source);

                let destPath = destination;
                if (isDestDir) {
                    const sourcePathParts = source.split('/');
                    const sourceFileName = sourcePathParts[sourcePathParts.length - 1];
                    destPath = `${destination}/${sourceFileName}`;
                }

                try {
                    stat(destPath);
                    if (!force) {
                        throw `${destPath}: already exists`;
                    }
                } catch (e) {
                }

                if (sourceStat.type === FILE_TYPE.DIR) {
                    try {
                        mkdir(destPath, sourceStat.mode);
                    } catch (e) {
                        if (!force || !e.includes("exists")) {
                            throw e;
                        }
                    }

                    const files = Object.keys(sourceStat.content);
                    for (const file of files) {
                        const subSource = `${source}/${file}`;
                        const subDest = `${destPath}/${file}`;

                        this.execute(["-f", subSource, subDest]);
                    }

                    rmdir(source);
                } else {
                    const content = readFile(source);
                    writeFile(destPath, content);

                    unlink(source);
                }
            } catch (e) {
                throw `${source}: ${e}`;
            }
        }

        return "";
    }
}

export class GREP extends Command {
    constructor() {
        super("grep", "print lines that match patterns", "grep [-i|v|n] FILE");
    }

    execute(args) {
        if (args.length < 1) {
            throw "missing operand";
        }

        let ignoreCase = false;
        let invertMatch = false;
        let showLineNumbers = false;
        let pattern = null;
        let files = [];

        for (const arg of args) {
            if (arg === "-i") {
                ignoreCase = true;
            } else if (arg === "-v") {
                invertMatch = true;
            } else if (arg === "-n") {
                showLineNumbers = true;
            } else if (pattern === null) {
                pattern = arg;
            } else {
                files.push(arg);
            }
        }

        if (pattern === null) {
            throw "missing pattern operand";
        }

        if (files.length === 0) {
            throw "missing file operand";
        }

        let results = [];
        let regexFlags = ignoreCase ? "i" : "";
        const regex = new RegExp(pattern, regexFlags);

        for (const file of files) {
            try {
                const normalizedPath = normalizePath(file);
                const content = readFile(normalizedPath);
                const lines = content.split("\n");

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const matches = regex.test(line);

                    if ((matches && !invertMatch) || (!matches && invertMatch)) {
                        if (files.length > 1) {
                            if (showLineNumbers) {
                                results.push(`${file}:${i + 1}:${line}`);
                            } else {
                                results.push(`${file}:${line}`);
                            }
                        } else {
                            if (showLineNumbers) {
                                results.push(`${i + 1}:${line}`);
                            } else {
                                results.push(line);
                            }
                        }
                    }
                }
            } catch (e) {
                throw `${file}: ${e}`;
            }
        }

        return results.join("\n");
    }
}

export class WC extends Command {
    constructor() {
        super("wc", "print newline, word, and byte counts for each file", "wc [-l|w|c|m] FILE");
    }

    execute(args) {
        let countLines = false;
        let countWords = false;
        let countBytes = false;
        let countChars = false;
        let files = [];

        if (args.length === 0 || args.every(arg => !arg.startsWith("-"))) {
            countLines = true;
            countWords = true;
            countBytes = true;

            if (args.length === 0) {
                throw "missing file operand";
            } else {
                files = args;
            }
        } else {
            for (const arg of args) {
                if (arg === "-l") {
                    countLines = true;
                } else if (arg === "-w") {
                    countWords = true;
                } else if (arg === "-c") {
                    countBytes = true;
                } else if (arg === "-m") {
                    countChars = true;
                } else if (!arg.startsWith("-")) {
                    files.push(arg);
                }
            }
        }

        if (files.length === 0) {
            throw "missing file operand";
        }

        let results = [];
        let totalLines = 0;
        let totalWords = 0;
        let totalBytes = 0;
        let totalChars = 0;

        for (const file of files) {
            try {
                const normalizedPath = normalizePath(file);
                const content = readFile(normalizedPath);

                let lineCount = 0;
                let wordCount = 0;
                let byteCount = 0;
                let charCount = 0;

                if (countLines || countWords) {
                    const lines = content.split("\n");
                    lineCount = lines.length;

                    if (countWords) {
                        for (const line of lines) {
                            const words = line.trim().split(/\s+/).filter(word => word.length > 0);
                            wordCount += words.length;
                        }
                    }
                }

                if (countBytes) {
                    byteCount = content.length;
                }

                if (countChars) {
                    charCount = content.length;
                }

                let result = "";
                if (countLines) {
                    result += ` ${lineCount}`;
                    totalLines += lineCount;
                }
                if (countWords) {
                    result += ` ${wordCount}`;
                    totalWords += wordCount;
                }
                if (countBytes) {
                    result += ` ${byteCount}`;
                    totalBytes += byteCount;
                }
                if (countChars) {
                    result += ` ${charCount}`;
                    totalChars += charCount;
                }

                results.push(`${result} ${file}`);
            } catch (e) {
                throw `${file}: ${e}`;
            }
        }

        if (files.length > 1) {
            let total = "";
            if (countLines) {
                total += ` ${totalLines}`;
            }
            if (countWords) {
                total += ` ${totalWords}`;
            }
            if (countBytes) {
                total += ` ${totalBytes}`;
            }
            if (countChars) {
                total += ` ${totalChars}`;
            }

            results.push(`${total} total`);
        }

        return results.join("\n");
    }
}

export class CHMOD extends Command {
    constructor() {
        super("chmod", "change file mode bits", "chmod [-r|-R] MODE FILE");
    }

    execute(args) {
        if (args.length < 2) {
            throw "missing operand";
        }

        let recursive = false;
        let mode = null;
        let files = [];

        for (const arg of args) {
            if (arg === "-R" || arg === "-r") {
                recursive = true;
            } else if (mode === null) {
                if (!/^[0-7]{3,4}$/.test(arg)) {
                    throw `invalid mode: '${arg}'`;
                }
                mode = parseInt(arg, 8);
            } else {
                files.push(arg);
            }
        }

        if (mode === null) {
            throw "missing mode operand";
        }

        if (files.length === 0) {
            throw "missing file operand";
        }

        for (const file of files) {
            try {
                const normalizedPath = normalizePath(file);
                this._chmod(normalizedPath, mode, recursive);
            } catch (e) {
                throw `${file}: ${e}`;
            }
        }

        return "";
    }

    _chmod(path, mode, recursive) {
        try {
            chmod(path, mode);

            const fileStat = stat(path);

            if (recursive && fileStat.type === FILE_TYPE.DIR) {
                const files = Object.keys(fileStat.content);
                for (const file of files) {
                    const subPath = `${path}/${file}`;
                    this._chmod(subPath, mode, recursive);
                }
            }
        } catch (e) {
            throw `${path}: ${e}`;
        }
    }
}

export class CHOWN extends Command {
    constructor() {
        super("chown", "change file owner and group", "chown [-r | -R] OWNER[:GROUP]");
    }

    execute(args) {
        if (args.length < 2) {
            throw "missing operand";
        }

        let recursive = false;
        let ownerGroup = null;
        let files = [];

        for (const arg of args) {
            if (arg === "-R" || arg === "-r") {
                recursive = true;
            } else if (ownerGroup === null) {
                ownerGroup = arg;
            } else {
                files.push(arg);
            }
        }

        if (ownerGroup === null) {
            throw "missing owner[:group] operand";
        }

        if (files.length === 0) {
            throw "missing file operand";
        }

        let owner;
        let group = null;

        if (ownerGroup.includes(":")) {
            [owner, group] = ownerGroup.split(":");
        } else {
            owner = ownerGroup;
        }

        if (owner === null && group === null) {
            throw `invalid owner[:group]: '${ownerGroup}'`;
        }

        const uid = getpwnam(owner);

        for (const file of files) {
            try {
                const normalizedPath = normalizePath(file);
                const gid = group ? getgrnam(group) : stat(normalizedPath).group;
                this._chown(normalizedPath, uid, gid, recursive);
            } catch (e) {
                throw `${file}: ${e}`;
            }
        }

        return "";
    }

    _chown(path, uid, gid, recursive) {
        try {
            chown(path, uid, gid);
        } catch (e) {
            throw `${path}: ${e}`;
        }

        const fileStat = stat(path);

        if (recursive && fileStat.type === FILE_TYPE.DIR) {
            const files = Object.keys(fileStat.content);
            for (const file of files) {
                const subPath = `${path}/${file}`;
                this._chown(subPath, uid, gid, recursive);
            }
        }
    }
}