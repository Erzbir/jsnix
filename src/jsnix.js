import {
    create_kernel,
    create_test_kernel,
    default_kernel,
} from './runtime/kernel.js';

function create_tty(options) {
    return default_kernel.create_tty(options);
}

export const JSNix = Object.freeze({
    create_kernel,
    create_test_kernel,
    get default_kernel() {
        return default_kernel;
    },
    boot(options) {
        return default_kernel.boot(options);
    },
    create_tty(options) {
        return default_kernel.create_tty(options);
    },
    get kernel() {
        return default_kernel.inspect;
    },
    version: '0.1.0-jsnix',
});

if (typeof window !== 'undefined') window.JSNix = JSNix;

export {
    create_tty,
    create_kernel,
    create_test_kernel,
    default_kernel,
};
