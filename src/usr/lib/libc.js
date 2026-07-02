/**
 * usr/lib/libc.js - C standard library compatibility exports
 *
 * Programs may import this user-space path, while the implementation lives in
 * kernel/abi so exec does not depend on usr/.
 */

'use strict';

export {
    make_libc,
    strerror,
} from '../../kernel/abi/libc.js';
