/**
 * init/rootfs/builder.js - Kernel-context root file-system writer
 *
 * These helpers populate the initial file system before normal user-space
 * permission checks are available.
 */

'use strict';

import {path_lookup, path_parent} from '../../kernel/fs/vfs.js';
import {
    S_IFCHR,
    S_IFDIR,
    S_IFLNK,
    S_IFREG,
} from '../../kernel/include/types.js';
import {inode_alloc} from '../../kernel/mm/slab.js';
import {printk} from '../../kernel/syscall/dispatcher.js';
import {byte_length} from '../../kernel/fs/bytes.js';

export function fs_write(abs_path, content, mode, uid, gid) {
    const [parent, name] = path_parent(abs_path);
    if (!parent) {
        printk(`init: fs_write: no parent for ${abs_path}`);
        return;
    }
    const existing = parent.i_data[name];
    if (existing?.i_type === 'file') {
        existing.i_data = content;
        existing.i_size = byte_length(content);
        existing.i_mode = S_IFREG | (mode ?? 0o644);
        existing.i_uid = uid ?? 0;
        existing.i_gid = gid ?? 0;
        existing.i_mtime = Date.now();
        return;
    }
    parent.i_data[name] = inode_alloc(
        S_IFREG,
        mode ?? 0o644,
        uid ?? 0,
        gid ?? 0,
        content,
    );
}

export function fs_mkdir(abs_path, mode, uid, gid) {
    if (path_lookup(abs_path)) return;
    const parts = abs_path.split('/').filter(Boolean);
    if (parts.length > 1)
        fs_mkdir('/' + parts.slice(0, -1).join('/'), 0o755, 0, 0);
    const [parent, name] = path_parent(abs_path);
    if (!parent) return;
    parent.i_data[name] = inode_alloc(
        S_IFDIR,
        mode ?? 0o755,
        uid ?? 0,
        gid ?? 0,
    );
    parent.i_nlink++;
    parent.i_mtime = parent.i_ctime = Date.now();
}

export function fs_symlink(target, abs_path) {
    const parts = abs_path.split('/').filter(Boolean);
    if (parts.length > 1)
        fs_mkdir('/' + parts.slice(0, -1).join('/'), 0o755, 0, 0);
    const [parent, name] = path_parent(abs_path);
    if (!parent) return;
    parent.i_data[name] = inode_alloc(S_IFLNK, 0o777, 0, 0, target);
}

export function fs_device(abs_path, device, mode, uid, gid) {
    const [parent, name] = path_parent(abs_path);
    if (!parent) return;
    const inode = inode_alloc(S_IFCHR, mode, uid, gid, '');
    inode.i_device = device;
    parent.i_data[name] = inode;
}
