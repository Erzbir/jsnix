import {main} from "./terminal.js";
import {appendFile, writeFile} from "./system/fs.js";
import {__main} from "./system/system.js";
import {chown, mkdir} from "./system/unistd.js";
import {getpwnam} from "./system/pwd.js";
import {CONFIG} from "./config.js";

const CTF = Object.freeze({
    flag1: 'b6b2b1cdd5f6adf6afd7c9b6eaddbdafb2dfbac1e3f2afe5cbe4e5d8efe5c0dfb4a9c7c7f2ceddc6afe0e9edbedcb0a2b9d6e9aad2e4afe2a2f1daf7bddcedf8c4d9c6bef5fcd8aae3becdcdd9cbdbe3b7cec7baa9bbacbdd4cac0b5a6bdc5cbbbc5ddf4e0afadd6f2abcef9ebdee8fbc7c5b1e3e5a5abafdadae9a8d3f5dcfdaecaaee5fbc8adc9a5d1c0b2ebe6f3ebc3cbd2c6f7c7b3b8b5d7cae2a7c9a4d5b9d7f5a5bdf7adabc1d5daf7edb8ccafc6a6aef1e4ccd6f3e6eceadcd2f8b2d2b8dfc7dadcc9a9e4a0e8bea0c1c2bda7c2cfd0fac8fcd9d5a8c2d7f4c0d7f3b2b4c8bbf6',
    flag2: 'flag is encrypted by xor(0x81)',
    hint1: 'I am going to fix some insecure configurations',
    hint2: '(ALL) NOPASSWD: /bin/bash',
});

function ctf_init() {
    const flag1_path = `/home/${CONFIG.credential.username}/flag.txt`;
    const hint1_path = `/home/${CONFIG.credential.username}/notes.txt`;

    writeFile(flag1_path, CTF.flag1, 0o600);
    writeFile(hint1_path, CTF.hint1, 0o600);

    const pwnam = getpwnam(CONFIG.credential.username);
    chown(flag1_path, pwnam.uid, pwnam.gid);
    chown(hint1_path, pwnam.uid, pwnam.gid);

    writeFile(`/root/flag.txt`, CTF.flag2, 0o600);
    writeFile("/etc/sudoers", CTF.hint2, 0o644)
}

function run() {
    appendFile("/etc/passwd", `${CONFIG.credential.username}:x:1000:1000::/home/${CONFIG.credential.username}:/bin/bash\n`);
    appendFile("/etc/shadow", `${CONFIG.credential.username}:${CONFIG.credential.password}:2048:0:99999:7:::\n`);
    mkdir(`/home/${CONFIG.credential.username}`, 0o750);
    const pwnam = getpwnam(CONFIG.credential.username);
    chown(`/home/${CONFIG.credential.username}`, pwnam.uid, pwnam.gid);

    ctf_init();

    __main(main, 0, 0, "/");
}

run();