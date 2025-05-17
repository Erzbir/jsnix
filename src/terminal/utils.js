import {getcwd, getuid} from "../system/unistd.js";
import {getpwuid} from "../system/pwd.js";

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
    path = path.trim();

    if (path.startsWith("~")) {
        path = path.replace('~', getpwuid(getuid()).homedir);
    }

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