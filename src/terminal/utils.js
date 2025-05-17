import {getcwd} from "../system/unistd.js";

export function getCurrentTime() {
    return new Date().toLocaleString();
}

export function getRandomIP() {
    return Array.from({length: 4}, () => Math.floor(Math.random() * 256)).join('.');
}

export const MODE_BITS = Object.freeze({
    r: 0b100,
    w: 0b010,
    x: 0b001,
})

export function normalizePath(path) {
    let base
    if (path instanceof Array) {
        base = path.join('/')
    } else {
        base = path.startsWith('/') ? '' : getcwd();
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


export function formatMode(mode) {
    const perms = [];

    perms.push((mode & 0o400) ? MODE_BITS.r : '-');
    perms.push((mode & 0o200) ? MODE_BITS.w : '-');
    perms.push((mode & 0o100) ? MODE_BITS.x : '-');

    perms.push((mode & 0o040) ? MODE_BITS.r : '-');
    perms.push((mode & 0o020) ? MODE_BITS.w : '-');
    perms.push((mode & 0o010) ? MODE_BITS.x : '-');

    perms.push((mode & 0o004) ? MODE_BITS.r : '-');
    perms.push((mode & 0o002) ? MODE_BITS.w : '-');
    perms.push((mode & 0o001) ? MODE_BITS.x : '-');

    return perms.join('');
}

export function parseMode(mode) {
    if (typeof mode === 'number') {
        return mode;
    }

    if (typeof mode === 'string' && mode.match(/^0[0-7]{3}$/)) {
        return parseInt(mode, 8);
    }

    if (typeof mode === 'string' && mode.length === 9) {
        let result = 0;

        // 用户权限
        if (mode[0] === 'r') result |= 0o400;
        if (mode[1] === 'w') result |= 0o200;
        if (mode[2] === 'x') result |= 0o100;

        // 组权限
        if (mode[3] === 'r') result |= 0o040;
        if (mode[4] === 'w') result |= 0o020;
        if (mode[5] === 'x') result |= 0o010;

        // 其他用户权限
        if (mode[6] === 'r') result |= 0o004;
        if (mode[7] === 'w') result |= 0o002;
        if (mode[8] === 'x') result |= 0o001;

        return result;
    }

    if (typeof mode === 'string' && mode.match(/^[0-7]{3}$/)) {
        return parseInt(mode, 8);
    }

    return 0o644;
}