/**
 * usr/shell/jobs.js - Bash job control
 *
 * Analogous to bash/jobs.c.
 */

'use strict';

import {ksyms} from '../../kernel/ksyms.js';
import {do_execve_async} from '../../kernel/exec/execve.js';
import {TASK_ZOMBIE} from '../../kernel/include/types.js';

export const bash_job_control_methods = {
    _job_marker(job) {
        const active = this.jobs.filter(item => !item.disowned);
        if (active.at(-1) === job) return '+';
        if (active.at(-2) === job) return '-';
        return ' ';
    },

    _alloc_job_id() {
        const used = new Set(this.jobs.map(job => job.id));
        let id = 1;
        while (used.has(id)) id++;
        this.job_seq = Math.max(this.job_seq, id);
        return id;
    },

    _format_job(job, long = false) {
        const pid = long ? `${String(job.pid).padStart(5)} ` : '';
        return `[${job.id}]${this._job_marker(job)} ${pid}` +
            `${(job.status ?? 'Running').padEnd(20)} ${job.command}`;
    },

    _builtin_jobs(args, out) {
        const long = args.includes('-l');
        for (const job of this.jobs.filter(item => !item.disowned))
            out.push({
                text: this._format_job(job, long),
                tone: 'normal',
            });
        return 0;
    },

    _current_job() {
        return [...this.jobs].reverse().find(job => !job.disowned) ?? null;
    },

    _previous_job() {
        return [...this.jobs].reverse().filter(job => !job.disowned)[1] ?? null;
    },

    _find_job(spec, out, command_name = 'jobs') {
        if (!spec || spec === '%%' || spec === '%+') {
            const current = this._current_job();
            if (current) return current;
            out?.push({text: `bash: ${command_name}: current: no such job`, tone: 'error'});
            return null;
        }
        if (spec === '%-') {
            const previous = this._previous_job();
            if (previous) return previous;
            out?.push({text: `bash: ${command_name}: previous: no such job`, tone: 'error'});
            return null;
        }
        if (String(spec).startsWith('%')) {
            const id = Number(String(spec).slice(1));
            const job = this.jobs.find(item => item.id === id && !item.disowned);
            if (job) return job;
            out?.push({text: `bash: ${command_name}: ${spec}: no such job`, tone: 'error'});
            return null;
        }

        const pid = Number(spec);
        if (Number.isInteger(pid)) {
            const job = this.jobs.find(item => item.pid === pid && !item.disowned);
            if (job) return job;
        }
        out?.push({
            text: `bash: ${command_name}: ${spec}: no such job`,
            tone: 'error',
        });
        return null;
    },

    _remove_job(job) {
        const index = this.jobs.indexOf(job);
        if (index >= 0) this.jobs.splice(index, 1);
    },

    _complete_job(job, output, exit_code, status = 'Done') {
        if (job.status === 'Terminated') return job;
        job.output = output ?? [];
        job.exit_code = Number.isInteger(exit_code) ? exit_code : 0;
        job.status = status;
        job.finished_at = Date.now();
        job.timer = null;
        job.resolve?.(job);
        if (this.on_job_output && job.output.length && !job.output_flushed) {
            job.output_flushed = true;
            this.on_job_output(job, job.output);
        }
        return job;
    },

    _terminate_job(job, signo = 15) {
        if (!job || job.status === 'Done' || job.status === 'Terminated')
            return;
        clearTimeout(job.timer);
        job.timer = null;
        job.status = 'Terminated';
        job.exit_code = 128 + signo;
        const task = ksyms.get_task(job.pid);
        if (task && task.state !== TASK_ZOMBIE)
            ksyms.syscall(
                this.pid,
                ksyms.nr.__NR_kill,
                -(job.pgid ?? job.pid),
                signo,
            );
        if (job.child?.is_alive)
            ksyms.syscall(job.child.pid, ksyms.nr.__NR_exit, job.exit_code);
        job.resolve?.(job);
    },

    _terminate_all_jobs(signo = 1) {
        for (const job of [...this.jobs])
            this._terminate_job(job, signo);
    },

    _flush_job_output(job, out) {
        if (!job.output_flushed) {
            out.push(...(job.output ?? []));
            job.output_flushed = true;
        }
    },

    _resume_job(job) {
        if (job.status !== 'Stopped') return;
        job.status = 'Running';
        ksyms.syscall(
            this.pid,
            ksyms.nr.__NR_kill,
            -(job.pgid ?? job.pid),
            ksyms.types.SIGCONT,
        );
        if (job.resume) job.resume();
    },

    _stop_job(job) {
        if (!job || job.status !== 'Running') return;
        job.status = 'Stopped';
        clearTimeout(job.timer);
        job.timer = null;
        ksyms.syscall(
            this.pid,
            ksyms.nr.__NR_kill,
            -(job.pgid ?? job.pid),
            ksyms.types.SIGSTOP,
        );
    },

    _builtin_bg(args, out) {
        const specs = args.length ? args : [null];
        let status = 0;
        for (const spec of specs) {
            const job = this._find_job(spec, out, 'bg');
            if (!job) {
                status = 1;
                continue;
            }
            if (job.status === 'Done' || job.status === 'Terminated') {
                out.push({text: `bash: bg: ${spec ?? `%${job.id}`}: job has terminated`, tone: 'error'});
                status = 1;
                continue;
            }
            this._resume_job(job);
            out.push({text: this._format_job(job), tone: 'normal'});
        }
        return status;
    },

    _builtin_disown(args, out) {
        const specs = args.filter(arg => !arg.startsWith('-'));
        const targets = specs.length
            ? specs.map(spec => this._find_job(spec, out, 'disown')).filter(Boolean)
            : [this._current_job()].filter(Boolean);
        if (!targets.length) return 1;
        for (const job of targets) {
            job.disowned = true;
            this._remove_job(job);
        }
        return 0;
    },

    _builtin_fg(args, out) {
        const job = this._find_job(args[0], out, 'fg');
        if (!job) return 1;
        if (job.status === 'Running' || job.status === 'Stopped') {
            out.push({
                text: `bash: fg: %${job.id}: job is still running`,
                tone: 'error',
            });
            return 1;
        }
        this._flush_job_output(job, out);
        this._remove_job(job);
        return job.exit_code ?? 0;
    },

    async _builtin_fg_async(args) {
        const out = [];
        const job = this._find_job(args[0], out, 'fg');
        if (!job) return this._builtin_result(out, 1);
        this._resume_job(job);
        if (job.promise) await job.promise;
        this._flush_job_output(job, out);
        const status = job.exit_code ?? 0;
        this._remove_job(job);
        this.last_exit_status = status;
        return this._builtin_result(out, status);
    },

    _jobs_for_wait(args, out) {
        if (!args.length) return this.jobs.filter(job => !job.disowned);
        const jobs = [];
        for (const spec of args) {
            const job = this._find_job(spec, out, 'wait');
            if (job) jobs.push(job);
        }
        return jobs;
    },

    _builtin_wait(args, out) {
        const jobs = this._jobs_for_wait(args, out);
        if (!jobs.length) return out.length ? 1 : 0;
        const running = jobs.find(job =>
            job.status === 'Running' || job.status === 'Stopped');
        if (running) {
            out.push({
                text: `bash: wait: %${running.id}: job is still running`,
                tone: 'error',
            });
            return 1;
        }
        let status = 0;
        for (const job of jobs) {
            this._flush_job_output(job, out);
            status = job.exit_code ?? 0;
            this._remove_job(job);
        }
        return status;
    },

    async _builtin_wait_async(args) {
        const out = [];
        const jobs = this._jobs_for_wait(args, out);
        if (!jobs.length)
            return this._builtin_result(out, out.length ? 1 : 0);
        let status = 0;
        for (const job of jobs) {
            this._resume_job(job);
            if (job.promise) await job.promise;
            this._flush_job_output(job, out);
            status = job.exit_code ?? 0;
            this._remove_job(job);
        }
        this.last_exit_status = status;
        return this._builtin_result(out, status);
    },

    _start_background_job(command) {
        const external = this._start_background_external_job(command);
        if (external) return external;

        const child = this._fork_subshell();
        ksyms.syscall(
            this.pid, ksyms.nr.__NR_setpgid, child.pid, child.pid);
        const job = {
            id: this._alloc_job_id(),
            pid: child.pid,
            pgid: child.pid,
            command,
            status: 'Running',
            child,
            output: [],
            output_flushed: false,
            exit_code: null,
        };
        this.jobs.push(job);
        job.promise = new Promise(resolve => {
            job.resolve = resolve;
            const run = () => {
                job.timer = null;
                if (job.status === 'Terminated') {
                    resolve(job);
                    return;
                }
                ksyms.set_task_state(child.pid, ksyms.types.TASK_RUNNING);
                let output = [];
                let status = 0;
                try {
                    output = child.execute(command, {record_history: false});
                    status = child.last_exit_status;
                } catch (error) {
                    output = [{text: `bash: ${error.message}`, tone: 'error'}];
                    status = 1;
                } finally {
                    if (child.is_alive)
                        ksyms.syscall(child.pid, ksyms.nr.__NR_exit, status);
                }
                this._complete_job(job, output, status);
            };
            job.resume = () => {
                if (job.timer || job.status !== 'Running') return;
                job.timer = setTimeout(run, 0);
                job.timer.unref?.();
            };
            job.resume();
        });
        this.last_exit_status = 0;
        return [{text: `[${job.id}] ${job.pid}`, tone: 'normal'}];
    },

    _start_background_external_job(command) {
        let pipeline;
        try {
            pipeline = this._parse_pipeline(this._expand_alias(command));
        } catch {
            return null;
        }
        if (pipeline.length !== 1) return null;
        const stage = pipeline[0];
        const tokens = [...stage.tokens];
        const assignments = [];
        while (tokens[0]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/))
            assignments.push(tokens.shift());
        if (!tokens.length) return null;
        const [cmd, ...raw_argv] = tokens;
        if (this._is_shell_builtin(cmd)) return null;

        const argv = raw_argv.flatMap(arg => this._expand_glob(arg));
        let stdin_data = '';
        if (stage.here_string !== null) {
            stdin_data = stage.here_string + '\n';
        } else if (stage.redir_in) {
            const read = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_readfile,
                stage.redir_in,
            );
            if (read.err) return null;
            stdin_data = read.val;
        }

        const saved_env = {};
        for (const assignment of assignments) {
            const equals = assignment.indexOf('=');
            const key = assignment.slice(0, equals);
            const envp = this.envp;
            saved_env[key] = {
                exists: Object.hasOwn(envp, key),
                value: envp[key],
            };
            ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_setenv,
                key,
                assignment.slice(equals + 1),
            );
        }

        const promise = do_execve_async(
            this._pid,
            this.uid,
            this.gid,
            this.cwd,
            [cmd, ...argv],
            stdin_data,
            0,
            {process_group: 'new'},
        );

        for (const [key, saved] of Object.entries(saved_env)) {
            if (saved.exists)
                ksyms.syscall(this._pid, ksyms.nr.__NR_setenv, key, saved.value);
            else
                ksyms.syscall(this._pid, ksyms.nr.__NR_unsetenv, key);
        }

        if (!promise?.pid) return null;
        const job = {
            id: this._alloc_job_id(),
            pid: promise.pid,
            pgid: promise.pid,
            command,
            status: 'Running',
            output: [],
            output_flushed: false,
            exit_code: null,
        };
        this.jobs.push(job);
        job.promise = Promise.resolve(promise).then(result => {
            const output = this._background_exec_output(result, stage);
            return this._complete_job(
                job,
                output,
                result?.exit_code ?? 127,
                result ? 'Done' : 'Terminated',
            );
        });
        this.last_exit_status = 0;
        return [{text: `[${job.id}] ${job.pid}`, tone: 'normal'}];
    },

    _background_exec_output(result, stage) {
        if (!result)
            return [{text: 'bash: command not found', tone: 'error'}];
        const output = [];
        let stderr_redirected = false;
        if (stage.redir_err) {
            const error_text = this._buffer_to_text(result.stderr_buf);
            const written = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_writefile,
                stage.redir_err,
                error_text,
                stage.redir_err_append,
            );
            if (written.err)
                output.push({text: `bash: ${stage.redir_err}: Cannot create file`, tone: 'error'});
            else
                stderr_redirected = true;
        }
        if (stage.redir_out) {
            const written = ksyms.syscall(
                this._pid,
                ksyms.nr.__NR_writefile,
                stage.redir_out,
                this._buffer_to_text(result.stdout_buf),
                stage.redir_append,
            );
            if (written.err)
                output.push({
                    text: `bash: ${stage.redir_out}: ${written.err === -13 ? 'Permission denied' : 'Cannot create file'}`,
                    tone: 'error',
                });
        } else {
            output.push(...result.stdout_buf);
        }
        if (!stderr_redirected) output.push(...result.stderr_buf);
        return output;
    },
};
