/**
 * apps/terminal/dom_terminal_style.js - Default terminal app stylesheet.
 *
 * The DOM renderer injects this stylesheet by default. Applications that own
 * their styling can pass `style: false` when mounting the renderer.
 */

'use strict';

export const DOM_TERMINAL_STYLE_ID = 'jsnix-dom-terminal-style';

export const DOM_TERMINAL_CSS = String.raw`
.jsnix-tty {
  --tty-bg: #090d0e;
  --tty-bg2: #0d1517;
  --tty-bg3: #111c1f;
  --tty-panel: #0f181b;
  --tty-border: #1b2e36;
  --tty-border2: #254050;
  --tty-green: #39ff85;
  --tty-green-dim: #1a7a42;
  --tty-cyan: #00e5ff;
  --tty-cyan-dim: #005f70;
  --tty-yellow: #ffd700;
  --tty-red: #ff4444;
  --tty-orange: #ff8c00;
  --tty-blue: #5fa8ff;
  --tty-magenta: #ff79c6;
  --tty-white: #c4d4d8;
  --tty-dim: #3a5560;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  position: relative;
  color: var(--tty-white);
  background: var(--tty-bg);
  font: 13px/1.5 "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
}

.jsnix-tty *,
.jsnix-tty *::before,
.jsnix-tty *::after {
  box-sizing: border-box;
}

.tty-titlebar,
.tty-input-bar,
.tty-statusbar {
  flex-shrink: 0;
  background: var(--tty-bg2);
}

.tty-titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--tty-border);
  user-select: none;
}

.tty-tb-dots {
  display: flex;
  gap: 6px;
}

.tty-tb-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.tty-tb-dot.red { background: #ff5f56; }
.tty-tb-dot.yellow { background: #ffbd2e; }
.tty-tb-dot.green { background: #27c93f; }

.tty-tb-title {
  flex: 1;
  color: var(--tty-dim);
  font-size: 11px;
  letter-spacing: 2px;
  text-align: center;
  text-transform: uppercase;
}

.tty-tb-clock,
.tty-statusbar {
  color: var(--tty-dim);
  font-size: 10px;
}

.tty-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.tty-sidebar {
  display: flex;
  flex-direction: column;
  width: 190px;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--tty-panel);
  border-right: 1px solid var(--tty-border);
}

.tty-sb-section {
  padding: 5px 0;
  border-bottom: 1px solid var(--tty-border);
}

.tty-sb-title {
  padding: 2px 10px 4px;
  color: var(--tty-dim);
  font-size: 9px;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.tty-sb-row {
  display: flex;
  gap: 4px;
  padding: 1px 10px;
  font-size: 11px;
}

.tty-sb-key {
  color: var(--tty-dim);
  font-size: 10px;
}

.tty-sb-val { color: var(--tty-cyan); }
.tty-sb-val.root { color: var(--tty-green); }

.tty-proc-list {
  flex: 1;
  overflow-y: auto;
}

.tty-proc-item {
  display: flex;
  gap: 4px;
  padding: 1px 10px;
  color: var(--tty-dim);
  font-size: 10px;
}

.tty-proc-item .pid {
  width: 26px;
  color: var(--tty-cyan-dim);
}

.tty-proc-item .comm {
  flex: 1;
  color: var(--tty-white);
}

.tty-proc-item .state { color: var(--tty-green-dim); }

.tty-term-area {
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.tty-output {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
}

.tty-app-active .tty-output {
  overflow: hidden;
  padding: 0;
}

.tty-line {
  display: block;
  min-height: 1.5em;
  white-space: pre-wrap;
  word-break: break-all;
}

.tty-tone-normal,
.tty-echo-command { color: var(--tty-white); }
.tty-tone-error { color: var(--tty-red); }
.tty-tone-success { color: var(--tty-green); }
.tty-tone-info { color: var(--tty-cyan); }
.tty-tone-warning { color: var(--tty-yellow); }
.tty-tone-muted { color: var(--tty-dim); }
.tty-tone-kernel { color: var(--tty-orange); }
.tty-tone-system {
  color: #556a72;
  font-style: italic;
}

.tty-tone-banner {
  color: var(--tty-green);
  font-size: 11px;
  line-height: 1.2;
}

.tty-file-normal,
.tty-file-file { color: inherit; }
.tty-file-directory {
  color: var(--tty-blue);
  font-weight: 700;
}
.tty-file-symlink { color: var(--tty-cyan); }
.tty-file-executable {
  color: var(--tty-green);
  font-weight: 700;
}
.tty-file-device {
  color: var(--tty-yellow);
  font-weight: 700;
}

.tty-editor-screen {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: 1fr auto;
  height: 100%;
  min-height: 100%;
  padding: 10px 14px;
  color: var(--tty-white);
  cursor: text;
  font-variant-ligatures: none;
  tab-size: 4;
  white-space: pre;
}

.tty-editor-body {
  overflow: hidden;
}

.tty-editor-row {
  display: flex;
  min-height: 1.5em;
  line-height: 1.5;
}

.tty-editor-line-no {
  flex: 0 0 4ch;
  margin-right: 1ch;
  color: var(--tty-dim);
  text-align: right;
  user-select: none;
}

.tty-editor-text {
  white-space: pre;
}

.tty-editor-cursor {
  display: inline-block;
  min-width: 1ch;
  color: var(--tty-bg);
  background: var(--tty-green);
}

.tty-editor-mode-insert .tty-editor-cursor {
  color: var(--tty-green);
  background: transparent;
  box-shadow: inset 2px 0 0 var(--tty-green);
}

.tty-editor-mode-command .tty-editor-cursor {
  background: var(--tty-cyan);
}

.tty-editor-status {
  display: flex;
  gap: 2ch;
  justify-content: space-between;
  min-height: 1.5em;
  margin-top: 6px;
  padding: 0 1ch;
  color: var(--tty-bg);
  background: var(--tty-green);
  line-height: 1.5;
  white-space: pre;
}

.tty-editor-mode-insert .tty-editor-status {
  background: var(--tty-yellow);
}

.tty-editor-mode-command .tty-editor-status {
  background: var(--tty-cyan);
}

.tty-editor-status-main,
.tty-editor-status-help {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tty-editor-status-main {
  min-width: 0;
}

.tty-editor-status-help {
  flex-shrink: 0;
  opacity: 0.7;
}

.tty-input-bar {
  display: flex;
  align-items: center;
  padding: 7px 14px;
  border-top: 1px solid var(--tty-border);
}

.tty-app-active .tty-input-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  padding: 0;
  border: 0;
  opacity: 0;
}

.tty-prompt {
  flex-shrink: 0;
  white-space: nowrap;
}

.tty-prompt-user { color: var(--tty-green); font-weight: 700; }
.tty-prompt-at,
.tty-prompt-colon,
.tty-prompt-password,
.tty-prompt-dead { color: var(--tty-dim); }
.tty-prompt-host,
.tty-prompt-login { color: var(--tty-cyan); }
.tty-prompt-path { color: var(--tty-yellow); }
.tty-prompt-dollar { color: var(--tty-green); font-weight: 700; }
.tty-prompt-root { color: var(--tty-red); font-weight: 700; }

.tty-cmd-input {
  flex: 1;
  padding: 0 4px;
  color: var(--tty-white);
  background: transparent;
  border: 0;
  outline: 0;
  caret-color: var(--tty-green);
  font: inherit;
}

.tty-cmd-input::-webkit-credentials-auto-fill-button {
  visibility: hidden;
  pointer-events: none;
}

.tty-statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 3px 14px;
  border-top: 1px solid var(--tty-border);
}

.tty-status-clock { margin-left: auto; }

.tty-chip {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tty-chip .dot {
  width: 5px;
  height: 5px;
  background: var(--tty-green);
  border-radius: 50%;
}
`;
