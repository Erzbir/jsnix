import {createProcess, setCurrent} from "./sys/proc.js";
import {NOT_DEATH_CODE_MARK} from "./sys/sys.js";
import {mkdir} from "./unistd.js";
import {createFile, writeFile} from "./fs.js";

const processes = [];

let _ = NOT_DEATH_CODE_MARK;

export function __main(main, uid, gid, cwd, ...args) {
    const process = createProcess(uid, gid, cwd);
    setCurrent(process);
    processes.push(process);
    new Promise(() => {
        main(args);
    }).then(_ => {
    })
}

mkdir("/boot");
mkdir("/dev");
mkdir("/etc");
mkdir("/home");
mkdir("/media");
mkdir("/mnt");
mkdir("/opt");
mkdir("/proc");
mkdir("/root", 0o700);
mkdir("/run");
mkdir("/sys", 0o555);
mkdir("/tmp");
mkdir("/usr");
mkdir("/var", 0o755);

mkdir("/usr/bin");
mkdir("/usr/include");
mkdir("/usr/lib");
mkdir("/usr/lib64");
mkdir("/usr/libexec");
mkdir("/usr/local");
mkdir("/usr/sbin");
mkdir("/usr/share");
mkdir("/usr/src");

writeFile("/etc/passwd", "root:x:0:0::/root:/bin/bash\n");
writeFile("/etc/group", "root:x:0:\n");
writeFile("/etc/shadow", "root:x:2048:0:99999:7:::\n");
writeFile("/etc/gshadow", "root:*::\n");

createFile("/etc/hosts", 0o644);