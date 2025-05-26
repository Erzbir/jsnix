import {register_syscall, SYSCALL_NO} from "./syscall.js";
import {current} from "./proc.js";

const Errno = Object.freeze({
    EPERM: 'Operation not permitted',
    EACCES: 'Permission denied',
    ENOENT: 'No such file or directory',
    EISDIR: 'Is a directory',
    ENOTDIR: 'Not a directory',
    EEXIST: 'File exists',
    ENOTEMPTY: 'Directory not empty',
    EBADF: 'Bad file descriptor',
    EINVAL: 'Invalid argument',
});

export const NOT_DEATH_CODE_MARK = 1;

function sys_getpid() {
    return current().pid;
}

function sys_getppid() {
    return current().ppid;
}

function sys_getcwd() {
    return current().cwd;
}

function sys_geteuid() {
    return current().egid
}

function sys_getuid() {
    return current().uid
}

function sys_getresuid() {
    return {
        ruid: current().uid,
        euid: current().euid,
        suid: -1
    };
}

function sys_setuid(uid) {
    if (current().euid !== 0 && current().uid !== uid && current().sgid !== uid) {
        return -1;
    }

    if (current().euid === 0) {
        current().uid = uid;
        current().euid = uid;
        current().suid = uid;
    } else {
        current().euid = uid;
    }

    return 0;
}

function sys_setreuid(ruid, euid) {
    if (ruid === -1) ruid = current().uid;
    if (euid === -1) euid = current().euid;

    if (current().euid !== 0 &&
        (ruid !== current().uid && ruid !== current().euid && ruid !== current().suid) ||
        (euid !== current().uid && euid !== current().euid && euid !== current().suid)) {
        return -1;
    }

    if (euid !== current().euid) {
        current().suid = euid;
    }

    current().uid = ruid;
    current().euid = euid;

    return 0;
}

function sys_setresuid(ruid, euid, suid) {
    if (ruid === -1) ruid = current().uid;
    if (euid === -1) euid = current().euid;
    if (suid === -1) suid = current().suid;

    if (current().euid !== 0 &&
        (ruid !== current().uid && ruid !== current().euid && ruid !== current().suid) ||
        (euid !== current().uid && euid !== current().euid && euid !== current().suid) ||
        (suid !== current().uid && suid !== current().euid && suid !== current().suid)) {
        return -1;
    }

    current().uid = ruid;
    current().euid = euid;
    current().suid = suid;

    return 0;
}

function sys_getgid() {
    return current().gid;
}

function sys_getegid() {
    return current().egid;
}

function sys_getresgid() {
    return {
        rgid: current().gid,
        egid: current().egid,
        sgid: current().sgid
    };
}

function sys_setgid(gid) {
    if (current().egid !== 0 && current().gid !== gid && current().sgid !== gid) {
        return -1
    }

    if (current().egid === 0) {
        current().gid = gid;
        current().egid = gid;
        current().sgid = gid;
    } else {
        current().egid = gid;
    }

    return 0;
}

function sys_setregid(rgid, egid) {
    if (rgid === -1) rgid = current().gid;
    if (egid === -1) egid = current().egid;

    if (current().egid !== 0 &&
        (rgid !== current().gid && rgid !== current().egid && rgid !== current().sgid) ||
        (egid !== current().gid && egid !== current().egid && egid !== current().sgid)) {
        return -1;
    }

    if (rgid !== current().egid) {
        current().sgid = egid;
    }

    current().gid = rgid;
    current().egid = egid;

    return 0;
}

function sys_setresgid(rgid, egid, sgid) {
    if (rgid === -1) rgid = current().gid;
    if (egid === -1) egid = current().egid;
    if (sgid === -1) sgid = current().sgid;

    if (current().egid !== 0 &&
        (rgid !== current().gid && rgid !== current().egid && rgid !== current().sgid) ||
        (egid !== current().gid && egid !== current().egid && egid !== current().sgid) ||
        (sgid !== current().gid && sgid !== current().egid && sgid !== current().sgid)) {
        return -1;
    }

    current().gid = rgid;
    current().egid = egid;
    current().sgid = sgid;

    return 0;
}

const OP_FLAG = Object.freeze({
    O_RDONLY: 0x0000,
    O_WRONLY: 0x0001,
    O_RDWR: 0x0002,
    O_CREAT: 0x0040,
    O_EXCL: 0x0080,
    O_NOCTTY: 0x0100,
    O_TRUNC: 0x0200,
    O_APPEND: 0x0400,
});

const FILE_TYPE = Object.freeze({
    DIR: 'd',
    FILE: 'f',
});

const O_ACC_MODE = 3;

const WHENCE = Object.freeze({
    SEEK_SET: 0,
    SEEK_CUR: 1,
    SEEK_END: 2,
});

const ROOT = {
    '/': {
        type: FILE_TYPE.DIR,
        content: {},
        mode: 0o755,
        owner: 0,
        group: 0,
        created: Date.now(),
        modified: Date.now()
    }
};

const openFiles = {};
let nextFd = 3;

/**
 * @param {Object} node
 * @param {number} accessMode
 * @returns {boolean}
 */
function checkPermission(node, accessMode) {
    if (current().egid === 0) {
        return true;
    }

    let permBits;

    if (node.owner === current().euid) {
        permBits = (node.mode >> 6) & 0o7;
    } else if (node.group === current.egid) {
        permBits = (node.mode >> 3) & 0o7;
    } else {
        permBits = node.mode & 0o7;
    }

    return (permBits & accessMode) === accessMode;
}

/**
 * @param {string} path
 * @returns {{parent: {}, name: string, node: {}}}
 */
function resolvePath(path) {
    const segments = path.split('/').filter(Boolean);
    let current = ROOT['/'];

    if (segments.length === 0) {
        return {parent: current, name: '/', node: current};
    }

    for (let i = 0; i < segments.length - 1; i++) {
        if (!current.content[segments[i]] || current.content[segments[i]].type !== FILE_TYPE.DIR) {
            throw Errno.ENOENT;
        }

        if (!checkPermission(current.content[segments[i]], 0o1)) {
            throw Errno.EACCES;
        }

        current = current.content[segments[i]];
    }

    const name = segments[segments.length - 1];
    const node = current.content[name];

    return {parent: current, name, node};
}

/**
 * @param {string} path
 * @param {number} flag
 * @param {number} mode
 * @returns {number}
 */
function sys_open(path, flag, mode) {
    const {parent, name} = resolvePath(path);

    if (name === '/' && !parent) {
        const requiredPerm = ((flag & O_ACC_MODE) === OP_FLAG.O_RDONLY) ? 0o4 :
            ((flag & O_ACC_MODE) === OP_FLAG.O_WRONLY) ? 0o2 : 0o6;

        if (!checkPermission(ROOT['/'], requiredPerm)) {
            throw Errno.EACCES;
        }

        const fd = nextFd++;
        openFiles[fd] = {
            path,
            flag,
            position: 0,
            node: ROOT['/']
        };

        return fd;
    }

    if ((flag & OP_FLAG.O_CREAT) && !parent.content[name]) {
        if (!checkPermission(parent, 0o2)) {
            throw Errno.EACCES;
        }

        parent.content[name] = {
            type: FILE_TYPE.FILE,
            content: '',
            mode: mode || (0o666 & (~current().umask)),
            owner: current().euid,
            group: current().egid,
            created: Date.now(),
            modified: Date.now()
        };
    } else if ((flag & OP_FLAG.O_CREAT) && (flag & OP_FLAG.O_EXCL) && parent.content[name]) {
        throw Errno.EEXIST;
    } else if (!parent.content[name]) {
        throw Errno.ENOENT;
    }

    const fileNode = parent.content[name];

    if (fileNode.type === FILE_TYPE.DIR && ((flag & O_ACC_MODE) !== OP_FLAG.O_RDONLY)) {
        throw Errno.EISDIR;
    }

    const requiredPerm = ((flag & O_ACC_MODE) === OP_FLAG.O_RDONLY) ? 0o4 :
        ((flag & O_ACC_MODE) === OP_FLAG.O_WRONLY) ? 0o2 : 0o6;

    if (!checkPermission(fileNode, requiredPerm)) {
        throw Errno.EACCES;
    }

    if ((flag & OP_FLAG.O_TRUNC) && (flag & O_ACC_MODE) !== OP_FLAG.O_RDONLY) {
        if (fileNode.type === FILE_TYPE.FILE) {
            fileNode.content = '';
            fileNode.modified = Date.now();
        }
    }

    const fd = nextFd++;
    openFiles[fd] = {
        path,
        flag,
        position: 0,
        node: fileNode
    };

    return fd;
}

/**
 * @param {number} fd
 * @param {number} length
 * @returns {string}
 */
function sys_read(fd, length) {
    if (!openFiles[fd]) {
        throw Errno.EBADF;
    }

    const file = openFiles[fd];

    if (file.node.type === FILE_TYPE.DIR) {
        throw Errno.EISDIR;
    }

    if ((file.flag & O_ACC_MODE) === OP_FLAG.O_WRONLY) {
        throw Errno.EACCES;
    }

    const content = file.node.content;
    const start = file.position;

    if (length === undefined || length === null) {
        length = content.length - start;
    }

    const end = Math.min(start + length, content.length);
    const data = content.substring(start, end);
    file.position = end;

    return data;
}

/**
 * @param {number} fd
 * @param {string} data
 * @returns {number}
 */
function sys_write(fd, data) {
    if (!openFiles[fd]) {
        throw Errno.EBADF;
    }

    const file = openFiles[fd];

    if (file.node.type === FILE_TYPE.DIR) {
        throw Errno.EISDIR;
    }

    if ((file.flag & O_ACC_MODE) === OP_FLAG.O_RDONLY) {
        throw Errno.EACCES;
    }

    const content = file.node.content;
    const position = file.position;

    if ((file.flag & OP_FLAG.O_APPEND)) {
        file.node.content += data;
        file.position = file.node.content.length;
    } else {
        file.node.content = content.substring(0, position) + data + content.substring(position);
        file.position += data.length;
    }

    file.node.modified = Date.now();

    return data.length;
}

/**
 * @param {number} fd
 * @param {number} offset
 * @param {number} whence
 * @returns {number}
 */
function sys_lseek(fd, offset, whence) {
    if (!openFiles[fd]) {
        throw Errno.EBADF;
    }

    const file = openFiles[fd];
    let newPosition;

    switch (whence) {
        case WHENCE.SEEK_SET:
            newPosition = offset;
            break;
        case WHENCE.SEEK_CUR:
            newPosition = file.position + offset;
            break;
        case WHENCE.SEEK_END:
            if (file.node.type === FILE_TYPE.FILE) {
                newPosition = file.node.content.length + offset;
            } else {
                throw Errno.EISDIR;
            }
            break;
        default:
            throw Errno.EINVAL;
    }

    if (newPosition < 0) {
        throw Errno.EINVAL;
    }

    file.position = newPosition;
    return file.position;
}

/**
 * @param {number} fd
 * @returns {boolean}
 */
function sys_close(fd) {
    if (!openFiles[fd]) {
        throw Errno.EBADF;
    }

    delete openFiles[fd];
    return true;
}

/**
 * @param {string} path
 * @param {number} mode
 * @returns {boolean}
 */
function sys_mkdir(path, mode) {
    const {parent, name} = resolvePath(path);

    if (!parent) {
        throw Errno.EPERM;
    }

    if (!checkPermission(parent, 0o2)) {
        throw Errno.EACCES;
    }

    if (parent.content[name]) {
        throw Errno.EEXIST;
    }

    parent.content[name] = {
        type: FILE_TYPE.DIR,
        content: {},
        mode: mode || (0o777 & (~current().umask)),
        owner: current().euid,
        group: current().egid,
        created: Date.now(),
        modified: Date.now()
    };

    return true;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function sys_unlink(path) {
    const {parent, name, node} = resolvePath(path);

    if (!parent) {
        throw Errno.EPERM;
    }

    if (!node) {
        throw Errno.ENOENT;
    }

    if (node.type === FILE_TYPE.DIR) {
        throw Errno.EISDIR;
    }

    if (!checkPermission(parent, 0o2)) {
        throw Errno.EACCES;
    }

    delete parent.content[name];
    return true;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function sys_rmdir(path) {
    const {parent, name, node} = resolvePath(path);

    if (!parent) {
        throw Errno.EPERM;
    }

    if (!node) {
        throw Errno.ENOENT;
    }

    if (node.type !== FILE_TYPE.DIR) {
        throw Errno.ENOTDIR;
    }

    if (Object.keys(node.content).length > 0) {
        throw Errno.ENOTEMPTY;
    }

    if (!checkPermission(parent, 0o2)) {
        throw Errno.EACCES;
    }

    delete parent.content[name];
    return true;
}

/**
 * @param {string} path
 * @returns {object}
 */
function sys_stat(path) {
    const {parent, name, node} = resolvePath(path);

    if (!node) {
        throw Errno.ENOENT;
    }

    if (!parent) {
        throw Errno.EPERM;
    }

    if (!checkPermission(parent, 0o1)) {
        throw Errno.EACCES;
    }

    if (node.type === FILE_TYPE.DIR) {
        if (!checkPermission(node, 0o1)) {
            throw Errno.EACCES;
        }
    }

    return {
        name: name,
        dev: 1,
        ino: 1,
        type: node.type,
        content: node.content,
        mode: node.mode,
        nlink: 1,
        owner: node.owner,
        group: node.group,
        rdev: 0,
        size: node.type === FILE_TYPE.FILE ? node.content.length : 0,
        blksize: 4096,
        blocks: Math.ceil((node.type === FILE_TYPE.FILE ? node.content.length : 0) / 4096),
        atime: node.modified,
        mtime: node.modified,
        ctime: node.created
    };
}

/**
 * @param {string} path
 * @param {number} mode
 * @returns {boolean}
 */
function sys_chmod(path, mode) {
    const {node} = resolvePath(path);

    if (!node) {
        throw Errno.ENOENT;
    }

    if (current().euid !== 0 && current().euid !== node.owner) {
        throw Errno.EPERM;
    }

    node.mode = mode & 0o777;

    return true;
}

/**
 * @param {string} path
 * @param {number} uid
 * @param {number} gid
 * @returns {boolean}
 */
function sys_chown(path, uid, gid) {
    const {node} = resolvePath(path);

    if (!node) {
        throw Errno.ENOENT;
    }

    if (current().euid !== 0) {
        throw Errno.EPERM;
    }

    if (uid !== -1) node.owner = uid;
    if (gid !== -1) node.group = gid;

    return true;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function sys_chdir(path) {
    const {parent, node} = resolvePath(path);

    if (!parent) {
        throw Errno.EPERM;
    }

    if (!node) {
        throw Errno.ENOENT;
    }

    if (node.type !== FILE_TYPE.DIR) {
        throw Errno.ENOTDIR;
    }

    if (!checkPermission(node, 0o1)) {
        throw Errno.EACCES;
    }

    current().cwd = path;
    return true;
}

register_syscall(SYSCALL_NO.__NR_getpid, sys_getpid);
register_syscall(SYSCALL_NO.__NR_getppid, sys_getppid);
register_syscall(SYSCALL_NO.__NR_getcwd, sys_getcwd);

register_syscall(SYSCALL_NO.__NR_getuid, sys_getuid);
register_syscall(SYSCALL_NO.__NR_getgid, sys_getgid);
register_syscall(SYSCALL_NO.__NR_getegid, sys_getegid);
register_syscall(SYSCALL_NO.__NR_geteuid, sys_geteuid);
register_syscall(SYSCALL_NO.__NR_setgid, sys_setgid);
register_syscall(SYSCALL_NO.__NR_setuid, sys_setuid);
register_syscall(SYSCALL_NO.__NR_setreuid, sys_setreuid);
register_syscall(SYSCALL_NO.__NR_setregid, sys_setregid);
register_syscall(SYSCALL_NO.__NR_setresuid, sys_setresuid);
register_syscall(SYSCALL_NO.__NR_setresgid, sys_setresgid);
register_syscall(SYSCALL_NO.__NR_getresuid, sys_getresuid);
register_syscall(SYSCALL_NO.__NR_getresgid, sys_getresgid);


register_syscall(SYSCALL_NO.__NR_open, sys_open);
register_syscall(SYSCALL_NO.__NR_read, sys_read);
register_syscall(SYSCALL_NO.__NR_write, sys_write);
register_syscall(SYSCALL_NO.__NR_close, sys_close);
register_syscall(SYSCALL_NO.__NR_mkdir, sys_mkdir);
register_syscall(SYSCALL_NO.__NR_rmdir, sys_rmdir);
register_syscall(SYSCALL_NO.__NR_unlink, sys_unlink);
register_syscall(SYSCALL_NO.__NR_stat, sys_stat);
register_syscall(SYSCALL_NO.__NR_lseek, sys_lseek);
register_syscall(SYSCALL_NO.__NR_chmod, sys_chmod);
register_syscall(SYSCALL_NO.__NR_chown, sys_chown);
register_syscall(SYSCALL_NO.__NR_chdir, sys_chdir);