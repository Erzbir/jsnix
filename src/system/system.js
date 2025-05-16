import {createProcess, setCurrent} from "./sys/proc.js";
import {NOT_DEATH_CODE_MARK} from "./sys/sys.js";
import {mkdir} from "./unistd.js";
import {writeFile} from "./fs.js";

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

mkdir("/home");
mkdir("/usr");
mkdir("/var");
mkdir("/tmp");
mkdir("/etc");
mkdir("/sys", 0o555);
mkdir("/dev");
mkdir("/root", 0o700);
writeFile("/etc/passwd", "root:x:0:0::/root:/bin/bash\n");
writeFile("/etc/group", "root:x:0:\n");
writeFile("/etc/shadow", "root:x:2048:0:99999:7:::\n");
writeFile("/etc/gshadow", "root:*::\n");