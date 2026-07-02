# JSNix architecture

JSNix is organized around a Linux-like runtime core with a small public facade.
The public API creates kernel facades and TTYs; the internal modules own boot,
the VFS, credentials, process state, command execution, and user-space
programs. Browser apps sit above that API and are not part of the kernel core.

## Source map

```text
apps/
└── <app-name>/
    ├── app.js               Browser app entry point
    ├── index.html           Optional standalone page
    └── ...                  App-owned assets and configuration

src/
├── jsnix.js                 Public API entry point
├── runtime/
│   └── kernel.js            Kernel facade, lazy boot, TTY creation
├── init/
│   ├── boot.js              Kernel boot orchestration
│   └── rootfs/
│       ├── builder.js       Kernel-context rootfs writer
│       ├── index.js         Directories, devices, accounts, system files
│       └── system_programs.js
├── kernel/
│   ├── abi/libc.js          Simulated syscall wrapper ABI
│   ├── exec/                execve, script loading, JSNix binary format
│   ├── fs/vfs.js            In-memory VFS and permission checks
│   ├── fs/file.js           Open-file-description references and fd lifetime
│   ├── fs/bytes.js          UTF-8 byte/offset helpers
│   ├── include/             Constants, errno, syscall numbers, mode bits
│   ├── mm/slab.js           Inode allocation
│   ├── sched/core.js        Task table and task state
│   ├── process/scheduler.js Compatibility exports for lifecycle helpers
│   ├── process/group.js     Process groups and sessions
│   ├── security/            Account and credential database
│   ├── syscall/dispatcher.js Syscall implementations and kernel_init
│   ├── tty/termios.js       Minimal TTY compatibility state
│   ├── cred.js              Credential mutation helpers
│   ├── fork.js              Process creation
│   ├── exit.js              Process exit and exit handlers
│   ├── signal.js            Signal delivery
│   ├── wait.js              Child collection and zombie reaping
│   ├── power.js             Shutdown and reboot state
│   ├── public.js            Read-only public kernel view
│   └── ksyms.js             Internal kernel symbol table
├── drivers/tty/
│   ├── core.js              Renderer-independent TTY service
│   ├── line_discipline.js   History and completion editing helpers
│   ├── editor_session.js    Foreground screen editor session
│   └── index.js
└── usr/
    ├── lib/libc.js          User-space libc wrapper around ksyms
    ├── shell/               Bash-like shell, parser, jobs, completion
    └── programs/            Built-in commands, security tools, editors

tests/
├── kernel-lifecycle.test.js
└── runtime.test.js
```

## Dependency direction

```text
browser app -> public JSNix API -> runtime/kernel facade
runtime facade -> boot, TTY core, read-only kernel view
boot -> rootfs builder -> VFS, credentials, program registry
TTY core -> Bash -> parser/jobs -> execve -> kernel syscalls
user program -> proc ctx/libc -> ksyms -> syscall dispatcher
syscall dispatcher -> VFS, scheduler, credentials, signals, power state
```

The `src/` runtime does not import from `apps/`. App code imports the public
API and may provide its own renderer, page, styling, and setup data.

## Public runtime

`src/jsnix.js` exports:

- `JSNix`
- `create_kernel()`
- `create_test_kernel()`
- `default_kernel`
- `create_tty()`

Importing `src/jsnix.js` creates `default_kernel` and registers built-in
programs through module side effects, but it does not boot the machine.
`boot()` or `create_tty()` starts the backend lazily.

The facade in `runtime/kernel.js` owns the public lifecycle:

- `boot(options)` starts the singleton backend if it is not already started.
- `create_tty(options)` splits boot options from TTY options, boots if needed,
  and returns a `tty_core`.
- `reset()` resets kernel, program, and shell-history state.
- `inspect` exposes the read-only view from `kernel/public.js`.
- `apply_profile(initializer)` is a convenience hook for callers that need to
  mutate the booted VFS through root shell commands.

Current isolation state: `kernel_facade.isolated` is `false`. Multiple facade
objects share the same singleton VFS, scheduler, credential store, and program
registry. `create_test_kernel()` resets that singleton before returning a new
facade.

## Boot sequence

`start_kernel()` in `init/boot.js` is the boot entry:

1. `kernel_init()` creates PID 1 in the scheduler.
2. `do_basic_setup()` verifies registered built-in binaries.
3. `populate_rootfs()` creates the base file-system hierarchy.
4. Device nodes, `/etc` files, account files, logs, and virtual `/proc` /
   `/sys`-style data are written.
5. Registered built-in programs are published as executable files.
6. Manual pages are rendered into `/usr/share/man/man1`.
7. Account state is loaded from `/etc/passwd`, `/etc/shadow`, and group files.
8. Home directories and skeleton files are created for interactive users.

Boot options include `hostname`, `issue`, `root_password`, `include_guest`,
`users`, and `accounts`. The rootfs builder normalizes these into account and
system-file contents before the credential layer is loaded.

## Kernel state

The kernel state is intentionally small and explicit:

- `kernel/fs/vfs.js` owns the in-memory superblock, path lookup, symlinks,
  permission checks, and VFS operations.
- `kernel/sched/core.js` owns the task table and task state.
- `kernel/security/credentials.js` owns account lookup and mutation, backed by
  the account files in the VFS.
- `kernel/fs/file.js` separates descriptor references from shared open file
  descriptions. `dup()` and `fork()` share offsets and status while `close()`
  drops one reference; pipes observe EOF only after the last writer closes.
- `kernel/process/group.js`, `kernel/signal.js`, and `kernel/wait.js` implement
  process groups, sessions, group signal delivery, stop/continue, zombie state,
  and explicit parent reaping.
- `kernel/syscall/dispatcher.js` uses Linux x86-64 numbers and fd signatures for
  the compatible syscall subset. Whole-file, termios convenience, environment,
  and account-management compatibility calls use a separate JSNix extension
  number range.
- `kernel/tty/termios.js` provides lightweight TTY compatibility for
  `isatty`, `tcgetattr`, `tcsetattr`, and window-size ioctls.

Path permissions follow Unix-style owner/group/other mode bits. Root bypasses
normal read/write/search checks, but executable files still need an execute bit.
Writes clear set-user-ID and set-group-ID bits, matching the intended security
model for modified files.

## Program execution

Executable files in the VFS are authoritative. The built-in program registry
keeps JavaScript closures for built-ins only while the published executable path
and source still match the file in the VFS.

`execve` performs:

1. Command lookup through `PATH` unless argv[0] contains `/`.
2. File type and execute-permission checks.
3. Shebang parsing for scripts beginning with `#!`.
4. JSNix executable image parsing through `binfmt_js.js`.
5. Task resource binding for argv, stdin, stdout, stderr, and executable path.
6. Set-user-ID / set-group-ID credential preparation.
7. Program execution through a `proc_ctx` and libc-style helpers.

Shell built-ins run inside the shell task because they mutate shell-local state
such as cwd, environment, aliases, history, credentials, jobs, or process
lifecycle. External commands run through `do_execve()` or `do_execve_async()`.

## Shell and TTY

The shell in `usr/shell/` parses command lists, pipelines, redirection,
variables, command substitution, scripts, and job-control operations. External
pipeline stages inherit kernel pipe descriptors through `dup2`; readers wait
for writer EOF. Redirections are opened before exec and installed on fd 0, 1,
or 2. Async pipelines share a process group that temporarily owns the
controlling TTY foreground slot.

The TTY core in `drivers/tty/core.js` is renderer-independent. It owns login
flow, shell session creation, history movement, completion, foreground command
coordination, and editor sessions. It emits events such as:

```text
output
prompt
input
echo
state
clear
power
app-screen
app-exit
lockout
```

Renderers decide how to display those events and how to map UI input back to
`submit()` and `handleKey()`. The kernel and TTY core do not own DOM, HTML, or
CSS.

Foreground screen programs can emit a control payload to enter an editor
session. While active, the TTY routes raw keys to `editor_session.js`, emits
`app-screen` updates, and releases the foreground task when the session exits.

## Built-in programs

Built-in programs are registered by importing `src/usr/programs/index.js`.
That module imports the core utilities, extended utilities, shells, security
tools, and editors. Registration happens before boot; publishing to the VFS
happens during boot.

To add a built-in command:

1. Implement the command under `src/usr/programs/`.
2. Register it with `register_binary()`.
3. Import the module from `src/usr/programs/index.js`.
4. Add tests that exercise the command through shell execution or syscall
   behavior.

If a command provides `man` metadata, boot writes it as a real VFS file under
`/usr/share/man/man1`. The `man`, `apropos`, and `whereis` programs inspect VFS
files rather than a separate help table.

## Scripts in the VFS

Executable lookup always uses the VFS, `PATH`, and file permissions.

- JSNix executable images start with a fixed `\x7fELFJSNIX` magic header
  followed by compact version, ABI, kind, and source-length fields.
- Script files start with `#!`; `execve` rewrites argv and starts the named
  interpreter, such as `/bin/bash` or `/usr/bin/env jsnix-js`.
- Plain printable text that returns `ENOEXEC` may be interpreted by the
  interactive shell as a shell-script fallback.

Built-in commands registered through `register_binary()` are written as JSNix
executable images, not shebang scripts.

## Browser app layer

The build system treats each `apps/<name>/app.js` as a browser app entry and
copies the matching `index.html` into debug, release, and obfuscated output
directories. Apps should depend on the public JSNix API rather than internal
kernel modules.

The app layer may provide:

- A DOM renderer for TTY events.
- Mount options that map UI attributes or configuration to kernel and TTY
  options.
- App-owned setup data supplied through the facade before starting user
  interaction.

Those app choices are outside the kernel architecture. The kernel boundary is
the public facade, the TTY event stream, and the read-only inspection view.

## Build outputs

`Makefile` builds two kernel formats:

```text
dist/debug/kernel/jsnix.js
dist/debug/kernel/jsnix.global.js
dist/release/kernel/jsnix.js
dist/release/kernel/jsnix.global.js
```

It also builds generic app bundles:

```text
dist/debug/apps/<app>/app.js
dist/debug/apps/<app>/index.html
dist/release/apps/<app>/app.js
dist/release/apps/<app>/index.html
dist/obfuscated/apps/<app>/app.js
dist/obfuscated/apps/<app>/index.html
```
