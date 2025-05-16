import {mkdir, readFile, writeFile} from "../system/fs.js";
import {Passwd, PASSWD_PATH} from "../system/pwd.js";
import {Group, GROUP_PATH} from "../system/grp.js";
import {chown} from "../system/unistd.js";
import {GShadow, GSHADOW_PATH, Shadow, SHADOW_PATH} from "../system/shadow.js";


function getNextUID() {
    const data = readFile(PASSWD_PATH);
    const lines = data.split('\n').filter(line => line.trim());
    const a_uid = lines.reduce((max, line) => {
        const user = Passwd.fromString(line);
        return user && user.uid > max ? user.uid : max;
    }, 999);
    return a_uid + 1;
}

function getNextGID() {
    const data = readFile(GROUP_PATH);
    const lines = data.split('\n').filter(line => line.trim());
    const a_gid = lines.reduce((max, line) => {
        const group = Group.fromString(line);
        return group && group.gid > max ? group.gid : max;
    }, 999);
    return a_gid + 1;
}

function getPasswdEntries() {
    const data = readFile(PASSWD_PATH);
    return data.split('\n')
        .filter(line => line.trim())
        .map(line => Passwd.fromString(line))
        .filter(entry => entry !== null);
}

function getGroupEntries() {
    const data = readFile(GROUP_PATH);
    return data.split('\n')
        .filter(line => line.trim())
        .map(line => Group.fromString(line))
        .filter(entry => entry !== null);
}

function getShadowEntries() {
    const data = readFile(SHADOW_PATH);
    return data.split('\n')
        .filter(line => line.trim())
        .map(line => Shadow.fromString(line))
        .filter(entry => entry !== null);
}

function getGShadowEntries() {
    const data = readFile(GSHADOW_PATH);
    return data.split('\n')
        .filter(line => line.trim())
        .map(line => GShadow.fromString(line))
        .filter(entry => entry !== null);
}

function writeEntriesToFile(path, entries) {
    const content = entries.map(entry => entry.toString()).join('\n') + '\n';
    return writeFile(path, content);
}

export function useradd(name, homedir, options = {}) {
    const defaults = {
        uid: null,
        gid: null,
        comment: '',
        shell: '/bin/bash',
        createGroup: true,
        createHome: false,
        password: 'x',
    };

    const opts = {...defaults, ...options};

    const passwdEntries = getPasswdEntries();
    if (passwdEntries.some(user => user.name === name)) {
        throw new Error(`user '${name}' already exists`);
    }

    const uid = opts.uid != null ? opts.uid : getNextUID();

    let gid = opts.gid != null ? opts.gid : getNextGID();
    if (!gid && opts.createGroup) {
        gid = groupadd(name);
    } else if (!gid) {
        gid = 100;
    }

    const newUser = new Passwd(
        name,
        opts.password || '',
        opts.uid || uid,
        opts.gid || gid,
        opts.comment || '',
        homedir || `/home/${name}`,
        opts.shell,
    );

    const shadowEntry = new Shadow(
        name,
        opts.password
    );

    passwdEntries.push(newUser);
    writeEntriesToFile(PASSWD_PATH, passwdEntries);

    const shadowEntries = getShadowEntries();
    shadowEntries.push(shadowEntry);
    writeEntriesToFile(SHADOW_PATH, shadowEntries);

    if (opts.createHome) {
        mkdir(newUser.homedir, 0o750);
        chown(newUser.homedir, newUser.uid, newUser.gid);
    }

    return uid;
}

export function groupadd(name, options = {}) {
    const defaults = {
        gid: null,
        password: 'x'
    };

    const opts = {...defaults, ...options};

    const groupEntries = getGroupEntries();
    if (groupEntries.some(group => group.name === name)) {
        throw new Error(`group '${name}' already exists`);
    }

    const gid = opts.gid != null ? opts.gid : getNextGID();

    const newGroup = new Group(
        name,
        opts.password,
        gid,
        []
    );

    const gshadowEntry = new GShadow(
        name,
        '*',
        [],
        []
    );

    groupEntries.push(newGroup);
    writeEntriesToFile(GROUP_PATH, groupEntries);

    const gshadowEntries = getGShadowEntries();
    gshadowEntries.push(gshadowEntry);
    writeEntriesToFile(GSHADOW_PATH, gshadowEntries);

    return gid;
}

export function userdel(name, options = {}) {
    const defaults = {
        removeGroup: true
    };

    const opts = {...defaults, ...options};

    const passwdEntries = getPasswdEntries();
    const shadowEntries = getShadowEntries();
    const groupEntries = getGroupEntries();
    const gshadowEntries = getGShadowEntries();

    const userIndex = passwdEntries.findIndex(user => user.name === name);
    if (userIndex === -1) {
        throw new Error(`user '${name}' does not exist`);
    }

    passwdEntries.splice(userIndex, 1);
    writeEntriesToFile(PASSWD_PATH, passwdEntries);

    const shadowIndex = shadowEntries.findIndex(entry => entry.name === name);
    if (shadowIndex !== -1) {
        shadowEntries.splice(shadowIndex, 1);
        writeEntriesToFile(SHADOW_PATH, shadowEntries);
    }

    if (opts.removeGroup) {
        const groupIndex = groupEntries.findIndex(group => group.name === name);
        if (groupIndex !== -1) {
            groupEntries.splice(groupIndex, 1);
            writeEntriesToFile(GROUP_PATH, groupEntries);

            const gshadowIndex = gshadowEntries.findIndex(entry => entry.name === name);
            if (gshadowIndex !== -1) {
                gshadowEntries.splice(gshadowIndex, 1);
                writeEntriesToFile(GSHADOW_PATH, gshadowEntries);
            }
        }
    }

    let modified = false;
    for (const group of groupEntries) {
        const memberIndex = group.members.indexOf(name);
        if (memberIndex !== -1) {
            group.members.splice(memberIndex, 1);
            modified = true;
        }
    }

    if (modified) {
        writeEntriesToFile(GROUP_PATH, groupEntries);
    }

    modified = false;
    for (const gshadow of gshadowEntries) {
        const memberIndex = gshadow.members.indexOf(name);
        if (memberIndex !== -1) {
            gshadow.members.splice(memberIndex, 1);
            modified = true;
        }

        const adminIndex = gshadow.administrators.indexOf(name);
        if (adminIndex !== -1) {
            gshadow.administrators.splice(adminIndex, 1);
            modified = true;
        }
    }

    if (modified) {
        writeEntriesToFile(GSHADOW_PATH, gshadowEntries);
    }

    return true;
}

export function groupdel(name) {
    const groupEntries = getGroupEntries();
    const gshadowEntries = getGShadowEntries();
    const passwdEntries = getPasswdEntries();

    const groupIndex = groupEntries.findIndex(group => group.name === name);
    if (groupIndex === -1) {
        throw new Error(`group '${name}' does not exist`);
    }

    const group = groupEntries[groupIndex];

    if (passwdEntries.some(user => user.gid === group.gid)) {
        throw new Error(`cannot remove group '${name}' because it is the primary group of a user`);
    }

    groupEntries.splice(groupIndex, 1);
    writeEntriesToFile(GROUP_PATH, groupEntries);

    const gshadowIndex = gshadowEntries.findIndex(entry => entry.name === name);
    if (gshadowIndex !== -1) {
        gshadowEntries.splice(gshadowIndex, 1);
        writeEntriesToFile(GSHADOW_PATH, gshadowEntries);
    }

    return true;
}

export function listUsers() {
    const passwdEntries = getPasswdEntries();
    return [...passwdEntries];
}


export function listGroups() {
    const groupEntries = getGroupEntries();
    return [...groupEntries];
}

export function getUserInfo(name) {
    const passwdEntries = getPasswdEntries();
    const user = passwdEntries.find(u => u.name === name);

    if (!user) return null;

    const groupEntries = getGroupEntries();
    const groups = groupEntries
        .filter(group => group.members.includes(name) || group.gid === user.gid)
        .map(group => group.name);

    return {
        name: user.name,
        uid: user.uid,
        gid: user.gid,
        gecos: user.gecos,
        homedir: user.homedir,
        shell: user.shell,
        groups
    };
}

export function getGroupInfo(name) {
    const groupEntries = getGroupEntries();
    const group = groupEntries.find(g => g.name === name);

    if (!group) return null;

    return {
        name: group.name,
        gid: group.gid,
        members: [...group.members]
    };
}

export function passwd(name, hashedPassword) {
    const shadowEntries = getShadowEntries();
    const passwdEntries = getPasswdEntries();

    if (!passwdEntries.some(user => user.name === name)) {
        throw new Error(`user '${name}' does not exist`);
    }

    const shadowIndex = shadowEntries.findIndex(entry => entry.name === name);

    if (shadowIndex === -1) {
        shadowEntries.push(new Shadow(
            name,
            hashedPassword,
            Math.floor(Date.now() / 86400000).toString()
        ));
    } else {
        shadowEntries[shadowIndex].password = hashedPassword;
        shadowEntries[shadowIndex].lastChanged = Math.floor(Date.now() / 86400000).toString();
    }

    writeEntriesToFile(SHADOW_PATH, shadowEntries);

    return true;
}