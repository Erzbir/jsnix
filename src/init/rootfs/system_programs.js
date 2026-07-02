/**
 * init/rootfs/system_programs.js - Essential executable images
 */

'use strict';

import {create_program_image} from '../../kernel/exec/binfmt_js.js';

export function create_nologin_program_image() {
    return create_program_image(ctx => {
        ctx.perror('This account is currently not available.');
        return 1;
    });
}

export function create_init_program_image() {
    return create_program_image(() => 0);
}
