import {JSNix} from '../../src/jsnix.js';
import {mountDOMTerminal} from './dom_terminal.js';

function defaultContainer() {
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-jsnix-terminal]') ??
        document.getElementById('terminal') ??
        document.getElementById('terminal-banner');
}

function hasDatasetValue(dataset, key) {
    return Object.prototype.hasOwnProperty.call(dataset, key);
}

function parseBanner(value) {
    if (value === 'false') return false;
    if (value === 'true') return true;
    return String(value).replaceAll('\\n', '\n');
}

export function readMountOptions(container) {
    const dataset = container.dataset ?? {};
    const options = {
        height: dataset.height ?? '570px',
        uid: Number(dataset.uid ?? 0),
        login: dataset.login === 'true',
        include_guest: dataset.guest !== 'false',
        sidebar: dataset.sidebar !== 'false',
        style: dataset.style !== 'false',
    };
    if (hasDatasetValue(dataset, 'rootPassword'))
        options.root_password = dataset.rootPassword;
    if (hasDatasetValue(dataset, 'banner'))
        options.banner = parseBanner(dataset.banner);
    if (hasDatasetValue(dataset, 'bannerFile'))
        options.banner_file = dataset.bannerFile;
    return options;
}

export function mountTerminal(
    container = defaultContainer(),
    api = JSNix,
    logger = console,
    renderer = mountDOMTerminal,
) {
    if (!container) {
        logger.error('[JSNix] Cannot find a terminal container');
        return null;
    }
    const options = readMountOptions(container);
    const tty = api.create_tty(options);
    return renderer(container, tty, options);
}

if (typeof document !== 'undefined') mountTerminal();
