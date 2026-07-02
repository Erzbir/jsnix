# Blog Security

Open `apps/blog-security/index.html` through a local web server and log in with:

```text
username: admin
password: admin
```

The challenge belongs to this app. It is implemented through normal accounts,
VFS permissions, `/etc/sudoers`, executable files, and kernel credential
changes. The old front-end-only Control-key backdoor is intentionally not part
of the kernel challenge.

The normal kernel boot does not contain Blog Security users, groups, files, or
policies. `apps/blog-security/app.js` creates the terminal, applies
`initChallenge()` through the JSNix kernel facade, and then starts the login
service. The initializer receives a profile context and performs all changes
through ordinary root commands before login starts.
