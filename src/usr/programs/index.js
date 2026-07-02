/**
 * usr/programs/index.js - Built-in user-space program set
 *
 * Importing this module registers the program images that are published into
 * the virtual root file system during boot.
 */

'use strict';

import './coreutils/index.js';
import './editors/vi.js';
import './extended/index.js';
import './shells.js';
import './security/su.js';
import './security/sudo.js';

import {reset_extended_state} from './extended/helpers.js';

export function reset_program_state() {
    reset_extended_state();
}
