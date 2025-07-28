import {BASE, SECURITY, STYLES, TEMPLATES} from "./config.js";
import {getCurrentTime, getRandomIP} from "./utils.js";

export const DOM = {
    hook: null,
    subtitle: null,
    logon: null,
    output: null,
    commandInput: null,
    commandPrompt: null,
    commandContainer: null,
    inputs: {
        username: null,
        password: null,
        okButton: null
    }
};

let typing = false;

export const ASCII_COLOR = Object.freeze({
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m"
});

export function isTyping() {
    return typing;
}

export function clearOutput() {
    DOM.output.innerHTML = '';
}

function createElementWithStyle(tagName, styles = {}, attributes = {}) {
    const element = document.createElement(tagName);

    Object.entries(styles).forEach(([prop, value]) => {
        element.style[prop] = value;
    });

    Object.entries(attributes).forEach(([attr, value]) => {
        element.setAttribute(attr, value);
    });

    return element;
}

function formatCommandOutput(command, output) {
    const fragment = document.createDocumentFragment();


    const promptSpan = document.createElement('span');
    promptSpan.style.color = STYLES.promptColor;
    promptSpan.textContent = DOM.commandPrompt.textContent;

    const commandSpan = document.createElement('span');
    commandSpan.textContent = command;
    commandSpan.style.color = STYLES.inputColor;
    commandSpan.style.wordBreak = 'break-all'

    const commandContainer = document.createElement('div');
    commandContainer.appendChild(promptSpan);
    commandContainer.appendChild(commandSpan);

    const outputContainer = document.createElement('div');
    outputContainer.appendChild(commandContainer);

    const resultContainer = document.createElement('div');

    if (output) {
        const outputSpan = document.createElement('span');
        outputSpan.style.wordBreak = 'break-all'

        if (output.startsWith('\x1b[')) {
            let asciiColor = output.match(/\x1b\[[0-9;]*m/g)[0].toLowerCase();
            switch (asciiColor) {
                case '\x1b[31m':
                    outputSpan.style.color = STYLES.errorColor;
                    break;
                case '\x1b[32m':
                    outputSpan.style.color = STYLES.outputColor;
                    break
                case '\x1b[33m':
                    outputSpan.style.color = STYLES.warnColor;
                    break;
            }
            output = output.replace(/\x1b\[[0-9;]*m/g, '');
        }

        outputSpan.innerHTML = output;
        resultContainer.appendChild(outputSpan);
    } else {
        resultContainer.appendChild(document.createElement('span'));
    }

    outputContainer.appendChild(resultContainer);

    fragment.appendChild(outputContainer);
    return fragment;
}

export function renderTemplate(template, data) {
    return template.replace(/{{\s*(\w+)\s*}}/g, (v, key) => data[key] ?? v);
}

function createStyles() {
    const style = document.createElement('style');
    style.textContent = `
                .terminal-container {
                    color: ${STYLES.terminalColor};
                    overflow: hidden;
                    font-family: ${STYLES.textFontFamily};
                    font-size: ${STYLES.textFontSize};
                }

               .terminal-title {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 15px;
                    font-weight: bold;
                    text-align: left;
                }

                .terminal-subtitle {
                    text-align: center;
                    font-weight: bold;
                    padding: 5px 0;
                }

                .terminal-body {
                    padding: 20px 15px;
                }

                .input-group {
                    display: flex;
                    align-items: center;
                    margin-bottom: 15px;
                    justify-content: center;
                }

                .input-label {
                    width: 100px;
                    text-align: right;
                    margin-right: 10px;
                }

                .input-field {
                    background-color: transparent;
                    border: none;
                    outline: none;
                    color: ${STYLES.terminalColor};
                    padding: 5px;
                    width: 16ch;
                    font-family: ${STYLES.textFontFamily};
                    font-size: ${STYLES.textFontSize};
                    -webkit-tap-highlight-color: transparent;
                }
                
                .input-field:active {
                    background-color: transparent;
                }

                .button-container {
                    display: flex;
                    justify-content: center;
                    margin: 20px 0;
                }

                .action-btn {
                    background-color: transparent;
                    color: ${STYLES.terminalColor};
                    padding: 5px 15px;
                    cursor: pointer;
                    transition: background-color 0.3s;
                    font-family: ${STYLES.textFontFamily};
                    border: none;
                }

                .action-btn:hover {
                    background-color: rgba(0, 0, 0, 0);
                }

                .terminal-footer {
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 15px;
                    border-top: 1px solid;
                    border-color: ${STYLES.terminalColor};
                }

                .output-content {
                    color: ${STYLES.printColor};
                    white-space: pre-wrap;
                    line-height: 1.5;
                }

                .command-container {
                    display: flex;
                    align-items: center;
                    margin-top: 10px;
                    display: none;
                }

                .command-prompt {
                    color: ${STYLES.promptColor};
                    margin-right: 5px;
                    user-select: none;
                    white-space: nowrap;
                }

                .command-input {
                    background: transparent;
                    border: none;
                    outline: none;
                    color: ${STYLES.inputColor};
                    flex-grow: 1;
                    font: inherit;
                }
            `;
    return style;
}

export function createDOMElements() {
    DOM.hook = document.getElementById(BASE.hook).attachShadow({mode: 'open'});

    const terminalContainer = createElementWithStyle('div', {}, {
        id: 'terminal-container',
        class: 'terminal-container'
    });
    DOM.hook.appendChild(terminalContainer);

    const terminalHeader = document.createElement('div');
    terminalHeader.id = 'terminal-header'
    terminalContainer.appendChild(terminalHeader);

    const terminalTitle = createElementWithStyle('div', {}, {class: 'terminal-title'});
    terminalTitle.textContent = BASE.terminalTitle;
    terminalHeader.appendChild(terminalTitle);

    const terminalLogon = createElementWithStyle('div', {}, {id: 'terminal-logon'});
    terminalLogon.id = 'terminal-logon'
    DOM.logon = terminalLogon;

    const subtitle = createElementWithStyle('div', {}, {class: 'terminal-subtitle'});
    subtitle.textContent = BASE.subtitle;
    terminalHeader.appendChild(subtitle);
    DOM.subtitle = subtitle;

    const terminalBody = createElementWithStyle('div', {}, {id: 'terminal-body', class: 'terminal-body'});
    terminalContainer.appendChild(terminalBody);

    const usernameGroup = createElementWithStyle('div', {}, {class: 'input-group'});
    const usernameLabel = createElementWithStyle('div', {}, {class: 'input-label'});
    usernameLabel.textContent = 'username:';
    DOM.inputs.username = createElementWithStyle('input', {}, {
        type: 'text',
        id: 'username',
        value: SECURITY.credential.username,
        class: 'input-field'
    });
    usernameGroup.appendChild(usernameLabel);
    usernameGroup.appendChild(DOM.inputs.username);
    terminalLogon.appendChild(usernameGroup);

    const passwordGroup = createElementWithStyle('div', {}, {class: 'input-group'});
    const passwordLabel = createElementWithStyle('div', {}, {class: 'input-label'});
    passwordLabel.textContent = 'password:';
    DOM.inputs.password = createElementWithStyle('input', {}, {
        type: 'password',
        id: 'password',
        class: 'input-field',
        autocomplete: 'off',
        readonly: '',
        onfocus: "setTimeout(() => this.removeAttribute('readonly'), 50)",
    });
    passwordGroup.appendChild(passwordLabel);
    passwordGroup.appendChild(DOM.inputs.password);
    terminalLogon.appendChild(passwordGroup);

    const buttonContainer = createElementWithStyle('div', {}, {class: 'button-container'});
    DOM.inputs.okButton = createElementWithStyle('button', {}, {
        id: 'ok-btn',
        class: 'action-btn',
    });
    DOM.inputs.okButton.textContent = STYLES.buttonText;

    buttonContainer.appendChild(DOM.inputs.okButton);
    terminalLogon.appendChild(buttonContainer);
    terminalBody.appendChild(terminalLogon);

    const terminalFooter = document.createElement('div');
    terminalFooter.id = 'terminal-footer';

    if (BASE.additional) {
        const additionalFooter = createElementWithStyle('div', {}, {class: 'terminal-footer'});
        additionalFooter.innerHTML = `<div>${BASE.additional}</div>`

        terminalFooter.appendChild(additionalFooter);
    }

    terminalContainer.appendChild(terminalFooter);

    DOM.output = createElementWithStyle('div', {display: 'none'}, {
        id: 'output',
        class: 'output-content'
    });
    terminalBody.appendChild(DOM.output);

    DOM.commandContainer = createElementWithStyle('div', {display: 'none'}, {
        id: 'command-container',
        class: 'command-container'
    });

    DOM.commandPrompt = createElementWithStyle('span', {}, {
        id: 'command-prompt',
        class: 'command-prompt'
    });
    DOM.commandPrompt.textContent = 'user:/ $ ';

    DOM.commandInput = createElementWithStyle('input', {}, {
        type: 'text',
        id: 'command-input',
        class: 'command-input',
        autocomplete: 'off',
        spellcheck: 'false'
    });

    DOM.commandContainer.appendChild(DOM.commandPrompt);
    DOM.commandContainer.appendChild(DOM.commandInput);
    terminalBody.appendChild(DOM.commandContainer);

    DOM.hook.appendChild(createStyles());
}

export function appendToOutput(input, color = '') {
    const outputContainer = document.createElement('div');
    if (color) {
        outputContainer.style.color = color;
    }
    if (input instanceof Node) {
        outputContainer.appendChild(input);
    } else {
        outputContainer.appendChild(document.createTextNode(input));
    }
    DOM.output.appendChild(outputContainer);
    DOM.output.scrollTop = DOM.output.scrollHeight;
}

export function appendToOutputCmd(command, output, color = '') {
    appendToOutput(formatCommandOutput(command, output), color);
}

async function typeLoadingLine(baseLine, index, spinDelay = 50, cycles = 10) {
    const spinner = STYLES.loadSpinner;
    const span = `<span id="loading-spin-${index}">|</span>`;

    const currentLine = document.createElement('span');
    currentLine.innerHTML = renderTemplate(baseLine, {
        LOADING: span
    });

    appendToOutput(currentLine);

    const spinElem = DOM.hook.getElementById(`loading-spin-${index}`);

    for (let i = 0; i < cycles; i++) {
        spinElem.textContent = spinner[i % spinner.length];
        await new Promise(resolve => setTimeout(resolve, spinDelay));
    }

    spinElem.textContent = STYLES.loadResult;
}

export async function typeContent(text) {
    const lines = text.split('\n');
    typing = true;

    let index = 0;
    for (let line of lines) {
        if (line.includes('{{LOADING}}')) {
            await typeLoadingLine(line, index);
            index++;
        } else {
            const outputContainer = document.createElement('span');
            appendToOutput(outputContainer);
            for (let char of line) {
                outputContainer.innerHTML += char;
                const delay = Math.random() *
                    (STYLES.typing.maxSpeed - STYLES.typing.minSpeed) +
                    STYLES.typing.minSpeed;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    typing = false;
}

export async function showTemplates(...templateNames) {
    const content = templateNames.map(id => TEMPLATES[id] || '').join('\n');

    function replacePlaceholders(content) {
        const time = getCurrentTime();
        const ipAddress = getRandomIP();
        const localIp = getRandomIP();
        const username = DOM.inputs.username?.value || 'unknown';

        return renderTemplate(content, {
            TIME: time,
            LAST_LOGIN_TIME: time,
            IP_ADDRESS: ipAddress,
            LOCAL_IP: localIp,
            USER: username
        });
    }

    const processedContent = replacePlaceholders(content);

    DOM.output.style.display = 'block';

    await typeContent(processedContent);
}

export function hideLoginForm() {
    if (DOM.subtitle && DOM.logon) {
        DOM.subtitle.style.display = 'none';
        DOM.logon.style.display = 'none';
    }
}