# JSNix

JSNix is a pure JavaScript, Linux-like runtime made by AI. It provides a
simulated kernel, virtual file system, process and credential model, TTY driver,
Bash-like shell, and user-space programs that run inside JavaScript without
delegating execution to the host operating system shell.

The runtime is renderer-independent. Browser apps, security labs, CTF or
training environments, demos, and tests can all use the same kernel, VFS,
shell, and user-space model.

## What is included

- Kernel boot lifecycle with PID 1, process table, fork/exec/wait, zombies,
  process groups, sessions, signals, exit handling, and a syscall dispatcher.
- Virtual root file system with Unix-style permissions, ownership, symlinks,
  device nodes, file descriptors, pipes, and account files.
- Users, groups, `/etc/passwd`, `/etc/shadow`, login authentication, `su`,
  `sudo`, and set-user-ID execution.
- Bash-like shell with history, completion, variables, quoting, fd-based
  redirection and pipelines, scripts, foreground process groups, job control,
  and executable lookup through `PATH`.
- Built-in user-space programs under `/bin`, `/usr/bin`, and `/usr/sbin`.
- Renderer-independent TTY API for interactive shells.
- Build targets for standalone kernel bundles and browser app bundles.

## Repository layout

```text
src/
  jsnix.js                  Public API entry point
  runtime/                  Public kernel facade
  init/                     Boot orchestration and rootfs construction
  kernel/                   VFS, scheduler, syscall, exec, creds, signals
  drivers/tty/              TTY core, line discipline, editor session
  usr/shell/                Bash-like shell, parser, jobs, completion
  usr/programs/             Built-in user-space programs and man pages
  usr/lib/                  User-space libc wrapper
  ARCHITECTURE.md           Internal architecture notes

apps/                       Browser apps built on the public JSNix API
tests/                      Node.js regression tests
Makefile                    Build pipeline for kernel and app bundles
```

Code using JSNix should import from `src/jsnix.js` during local development or
from the package entry after building. Internal kernel modules are not stable
public APIs.

## Requirements

- Node.js with native ESM support and `node --test`
- `pnpm` or `npm`
- `make`

The lockfile is `pnpm-lock.yaml`, so `pnpm install` is the preferred install
command. `npm install` also works with the current scripts.

## Quick start

Install dependencies:

```sh
pnpm install
```

Run the regression tests:

```sh
pnpm test
```

## Using the kernel

Create a kernel facade and a TTY:

```js
import {JSNix} from './src/jsnix.js';

const kernel = JSNix.create_kernel({
  hostname: 'labhost',
  issue: 'Training Lab\nAuthorized users only\n',
  root_password: 'toor',
  include_guest: false,
  users: [{
    username: 'alice',
    password: 'alicepw',
    gecos: 'Alice Example',
    groups: [100],
  }],
});

const tty = kernel.create_tty({
  login: false,
  uid: 0,
});

tty.on('output', line => {
  console.log(line.text);
});

tty.on('prompt', prompt => {
  console.log(prompt.label);
});

tty.start();
tty.submit('whoami');
```

Useful exports:

```js
import {
  JSNix,
  create_kernel,
  create_test_kernel,
  default_kernel,
} from './src/jsnix.js';
```

`create_kernel()` returns a kernel facade. It boots lazily when `boot()` or
`create_tty()` is called. `create_test_kernel()` resets mutable runtime state
before returning a facade, which is useful in tests.

`kernel.inspect` exposes a read-only view for tasks, users, groups, simple
stat data, and path resolution:

```js
const tasks = kernel.inspect.tasks();
const root = kernel.inspect.getUser('root');
const etc = kernel.inspect.stat('/etc');
```

Current isolation note: `kernel.isolated` is `false`. Multiple facades still
share the singleton backend VFS, scheduler, credential store, and program
registry. The facade gives callers an instance-shaped API while the lower
layers are migrated toward true isolated kernels.

JavaScript executable images are not a security sandbox. They run in the host
JavaScript realm and must only contain trusted code. The simulated Unix
permissions and credentials protect the virtual system model; they do not
isolate code from browser or Node.js globals.

The syscall ABI uses Linux x86-64 numbers and fd signatures for the compatible
subset (`read=0`, `write=1`, `open=2`, `close=3`, `wait4=61`, and so on).
JSNix-only compatibility services, including whole-file helpers and account
management operations, live in a separate extension number range.

## Boot options

The kernel facade and TTY creation accept these boot options:

```text
hostname         Hostname written to /etc/hostname
issue            Banner text written to /etc/issue
root_password    Initial root password
include_guest    Whether to create the default guest account
users/accounts   Additional or overridden interactive accounts
```

TTY-specific options include:

```text
login            Start with a login prompt instead of a shell
uid              UID for a non-login shell
env              Extra shell environment values
banner           true, false, string, array, or line objects
banner_file      VFS path used as the banner source
```

## Rootfs and accounts

Boot creates a Linux-like root file system and writes account state into normal
Unix-style files:

- `/etc/passwd`
- `/etc/shadow`
- `/etc/group`
- `/etc/gshadow`
- `/etc/subuid`
- `/etc/subgid`
- `/etc/hostname`
- `/etc/issue`

System accounts such as `root`, service users, and `nobody` are always present.
The interactive `guest` account is optional and enabled by default. Additional
users passed through `users` or `accounts` are created with a private primary
group, a home directory under `/home/<username>` unless configured otherwise,
shell `/bin/bash`, and optional supplemental groups.

Account lookup reloads from the account files, so login, `su`, `sudo`, and
user-space commands all observe the same state.

## Built-in programs

Built-in programs live under `src/usr/programs/` and are registered through the
internal program registry. During boot, registered binaries are installed into
the simulated VFS as JSNix executable images under paths such as `/bin`,
`/usr/bin`, and `/usr/sbin`.

Programs can provide manual metadata through the program registry. Boot writes
those pages into `/usr/share/man/man1/*.1`, and `man` / `apropos` read those
files from the VFS.

To add a built-in command:

1. Add the implementation under `src/usr/programs/`.
2. Register it with the internal program registry.
3. Import the module from `src/usr/programs/index.js`.
4. Add focused tests under `tests/`.

## Scripts inside JSNix

Executable lookup follows the VFS, `PATH`, and file permissions. Shell scripts
can be created inside the simulated system:

```sh
printf 'echo hello from shell\n' > /usr/local/bin/hello-sh
chmod +x /usr/local/bin/hello-sh
hello-sh
```

JavaScript scripts can use the JSNix script interpreter:

```sh
printf '#!/usr/bin/env jsnix-js\nctx.printf("hello from js")\n' > /usr/local/bin/hello-js
chmod +x /usr/local/bin/hello-js
hello-js
```

Registered built-in commands are not shebang scripts. They are written with a
fixed JSNix executable magic header and loaded by the JSNix binary-format
handler.

## Build

Build the release kernel and app bundles:

```sh
make
```

Common targets:

```sh
make debug       # readable debug bundles with sourcemaps
make release     # release kernel, release apps, obfuscated apps
make kernel      # release kernel bundle only
make apps        # release and obfuscated app bundles only
make test        # node --test tests/*.test.js
make clean       # remove build/ and dist/
```

Equivalent npm scripts are also available:

```sh
npm run build
npm run build:debug
npm run build:release
npm run build:kernel
npm run build:apps
npm test
```

Build outputs:

```text
dist/debug/kernel/jsnix.js
dist/debug/kernel/jsnix.global.js
dist/release/kernel/jsnix.js
dist/release/kernel/jsnix.global.js

dist/debug/apps/<app>/app.js
dist/debug/apps/<app>/index.html
dist/release/apps/<app>/app.js
dist/release/apps/<app>/index.html
dist/obfuscated/apps/<app>/app.js
dist/obfuscated/apps/<app>/index.html
```

For deeper implementation notes, see `src/ARCHITECTURE.md`.
