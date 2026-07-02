'use strict';

export const BLOG_SECURITY_CHALLENGE = Object.freeze({
    account: Object.freeze({
        username: 'admin',
        password: 'admin',
        home: '/home/admin',
        shell: '/bin/bash',
    }),
    ui: Object.freeze({
        login_check: Object.freeze({
            spinner_ticks: 8,
            spinner_delay_ms: 35,
            reduced_motion_spinner_ticks: 1,
            reduced_motion_spinner_delay_ms: 0,
        }),
    }),
    encrypted_flag:
        'b6b2b1cdd5f6adf6afd7c9b6eaddbdafb2dfbac1e3f2afe5cbe4e5d8efe5c0dfb4a9c7c7f2ceddc6afe0e9edbedcb0a2b9d6e9aad2e4afe2a2f1daf7bddcedf8c4d9c6bef5fcd8aae3becdcdd9cbdbe3b7cec7baa9bbacbdd4cac0b5a6bdc5cbbbc5ddf4e0afadd6f2abcef9ebdee8fbc7c5b1e3e5a5abafdadae9a8d3f5dcfdaecaaee5fbc8adc9a5d1c0b2ebe6f3ebc3cbd2c6f7c7b3b8b5d7cae2a7c9a4d5b9d7f5a5bdf7adabc1d5daf7edb8ccafc6a6aef1e4ccd6f3e6eceadcd2f8b2d2b8dfc7dadcc9a9e4a0e8bea0c1c2bda7c2cfd0fac8fcd9d5a8c2d7f4c0d7f3b2b4c8bbf6',
    user_hint: 'I am going to fix some insecure configurations',
    root_hint: 'flag is encrypted by xor(0x81)',
    sudoers: [
        'Defaults env_reset',
        'root ALL=(ALL:ALL) ALL',
        'admin ALL=(ALL) NOPASSWD: /bin/bash',
        '',
    ].join('\n'),
    paths: Object.freeze({
        encrypted_flag: '/home/admin/flag.txt',
        user_hint: '/home/admin/notes.txt',
        root_hint: '/root/flag.txt',
        sudoers: '/etc/sudoers',
    }),
});
