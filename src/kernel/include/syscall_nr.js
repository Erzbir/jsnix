// kernel/include/syscall_nr.js
// Linux x86-64 syscall numbers for the ABI-compatible subset.

// File and VFS system calls.
export const __NR_read      =   0;
export const __NR_write     =   1;
export const __NR_open      =   2;
export const __NR_close     =   3;
export const __NR_stat      =   4;
export const __NR_lstat     =   6;
export const __NR_lseek     =   8;
export const __NR_ioctl     =  16;
export const __NR_access    =  21;
export const __NR_pipe      =  22;
export const __NR_dup       =  32;
export const __NR_dup2      =  33;
export const __NR_truncate  =  76;
export const __NR_getdents  =  78;
export const __NR_getcwd    =  79;
export const __NR_chdir     =  80;
export const __NR_rename    =  82;
export const __NR_mkdir     =  83;
export const __NR_rmdir     =  84;
export const __NR_link      =  86;
export const __NR_unlink    =  87;
export const __NR_symlink   =  88;
export const __NR_readlink  =  89;
export const __NR_chmod     =  90;
export const __NR_chown     =  92;

// Compatibility aliases retained while callers migrate to Linux names.
export const __NR_readfd = __NR_read;
export const __NR_writefd = __NR_write;

// Process management.
export const __NR_getpid    =  39;
export const __NR_exit      =  60;
export const __NR_wait4     =  61;
export const __NR_kill      =  62;
export const __NR_umask     =  95;
export const __NR_getuid    = 102;
export const __NR_getgid    = 104;
export const __NR_setuid    = 105;
export const __NR_setgid    = 106;
export const __NR_geteuid   = 107;
export const __NR_getegid   = 108;
export const __NR_setpgid   = 109;
export const __NR_getppid   = 110;
export const __NR_setsid    = 112;
export const __NR_getgroups = 115;
export const __NR_setgroups = 116;
export const __NR_getpgid   = 121;
export const __NR_getsid    = 124;

// System information.
export const __NR_uname     =  63;
export const __NR_sysinfo   =  99;
export const __NR_syslog    = 103;
export const __NR_reboot    = 169;
export const __NR_time      = 201;
export const __NR_faccessat2 = 439;

// JSNix extension range. These are compatibility services, not Linux
// syscalls, and are deliberately kept out of the x86-64 number space.
export const __NR_readfile  = 400;
export const __NR_writefile = 401;
export const __NR_realpath  = 402;
export const __NR_getlogin  = 410;
export const __NR_isatty    = 420;
export const __NR_tcgetattr = 421;
export const __NR_tcsetattr = 422;

export const __NR_useradd   = 500;
export const __NR_userdel   = 501;
export const __NR_passwd    = 502;
export const __NR_su        = 503;
export const __NR_getpwnam  = 504;
export const __NR_getpwuid  = 505;
export const __NR_usermod   = 506;
export const __NR_groupadd  = 507;
export const __NR_groupdel  = 508;
export const __NR_groupmod  = 509;
export const __NR_getgrnam  = 510;
export const __NR_getgrgid  = 511;
export const __NR_groupmem  = 512;

export const __NR_getenv    = 530;
export const __NR_setenv    = 531;
export const __NR_unsetenv  = 532;
