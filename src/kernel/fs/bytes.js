/** UTF-8 byte helpers used at the VFS and syscall boundary. */

'use strict';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function text_bytes(value) {
    return encoder.encode(String(value ?? ''));
}

export function byte_length(value) {
    return text_bytes(value).byteLength;
}

export function slice_text_bytes(value, start = 0, end = undefined) {
    const bytes = text_bytes(value);
    const slice = bytes.slice(start, end);
    return {text: decoder.decode(slice), length: slice.byteLength};
}

export function replace_text_bytes(value, offset, replacement) {
    const current = text_bytes(value);
    const inserted = text_bytes(replacement);
    const end = offset + inserted.byteLength;
    const size = Math.max(current.byteLength, end);
    const output = new Uint8Array(size);
    output.set(current.slice(0, offset), 0);
    output.set(inserted, offset);
    if (end < current.byteLength)
        output.set(current.slice(end), end);
    return {
        text: decoder.decode(output),
        written: inserted.byteLength,
        size: output.byteLength,
    };
}

export function resize_text_bytes(value, length) {
    const current = text_bytes(value);
    const output = new Uint8Array(length);
    output.set(current.slice(0, length));
    return decoder.decode(output);
}
