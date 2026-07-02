// kernel/include/types.js
// Analogous to: include/linux/types.h, include/uapi/asm-generic/errno-base.h

// Privilege rings.
export const RING_KERNEL = 0;
export const RING_ROOT = 1;
export const RING_USER = 2;

// Task states.
export const TASK_RUNNING = 'R';
export const TASK_SLEEPING = 'S';
export const TASK_ZOMBIE = 'Z';
export const TASK_STOPPED = 'T';

// Inode type flags.
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFLNK = 0o120000;

// Discretionary access control permission bits.
export const S_IRUSR = 0o400;
export const S_IWUSR = 0o200;
export const S_IXUSR = 0o100;
export const S_IRGRP = 0o040;
export const S_IWGRP = 0o020;
export const S_IXGRP = 0o010;
export const S_IROTH = 0o004;
export const S_IWOTH = 0o002;
export const S_IXOTH = 0o001;
export const S_ISVTX = 0o1000;
export const S_ISUID = 0o4000;
export const S_ISGID = 0o2000;

// Inode type predicates.
export const S_ISREG = m => (m & 0o170000) === S_IFREG;
export const S_ISDIR = m => (m & 0o170000) === S_IFDIR;
export const S_ISLNK = m => (m & 0o170000) === S_IFLNK;
export const S_ISCHR = m => (m & 0o170000) === S_IFCHR;

// Access masks.
export const MAY_EXEC = 1;
export const MAY_WRITE = 2;
export const MAY_READ = 4;

// Error numbers.
export const EPERM = 1;
export const ENOENT = 2;
export const ESRCH = 3;
export const EINTR = 4;
export const EIO = 5;
export const ENOEXEC = 8;
export const EBADF = 9;
export const ECHILD = 10;
export const EAGAIN = 11;
export const EACCES = 13;
export const EEXIST = 17;
export const ENODEV = 19;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const ENOTTY = 25;
export const ESPIPE = 29;
export const EPIPE = 32;
export const ENOSYS = 38;
export const ENOTEMPTY = 39;
export const ELOOP = 40;

// wait4(2) options.
export const WNOHANG = 1;
export const WUNTRACED = 2;
export const WCONTINUED = 8;

// Open flags.
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;

// *at(2) constants.
export const AT_FDCWD = -100;
export const AT_EACCESS = 0x200;

// lseek(2) whence values.
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

// Minimal termios flags and ioctl request identifiers.
export const ISIG = 0x0001;
export const ICANON = 0x0002;
export const ECHO = 0x0008;
export const TIOCGWINSZ = 'TIOCGWINSZ';
export const TIOCSWINSZ = 'TIOCSWINSZ';
export const TIOCGPGRP = 'TIOCGPGRP';
export const TIOCSPGRP = 'TIOCSPGRP';

// Signal numbers.
export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGKILL = 9;
export const SIGTERM = 15;
export const SIGSTOP = 19;
export const SIGCONT = 18;

// Well-known user IDs, group IDs, and process IDs.
export const ROOT_UID = 0;
export const ROOT_GID = 0;
export const INIT_PID = 1;
