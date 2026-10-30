// settings.js - the backend's settings: the defaults, then settings.json (when it exists), then the command line.
//
//   loadSettings(argv, defaultFile) -> settings
//
// settings.json (next to index.js, or the file given with --settings <file>); every key is optional:
//   {
//       "port": 8080,
//       "open": false,
//       "allowOrigins": ["https://webscope.example.com"],   web pages on other origins that may use this backend
//       "allowHosts": ["scope.example.com"],                more names this backend may be reached by
//       "hostCheck": true,
//       "sigrokCli": "C:/Program Files/sigrok/sigrok-cli/sigrok-cli.exe",   like env SIGROK_CLI
//       "logicAnalyzerHosts": ["192.168.1.20:4045"]                          like env LOGICANALYZER_HOSTS
//   }
//
// Command line (wins over settings.json; the lists add to the ones in settings.json):
//   --port <n>  --open  --allow-origin <origin>  --allow-host <name>  --no-host-check  --settings <file>
//   --allow-admin   run as root/administrator (refused otherwise); command line only, not in settings.json
//
// The access checks (isHostAllowed / isOriginAllowed) are here too, as they only depend on the settings.

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const TYPES = {
    port: 'number',
    open: 'boolean',
    allowOrigins: 'string[]',
    allowHosts: 'string[]',
    hostCheck: 'boolean',
    sigrokCli: 'string',
    logicAnalyzerHosts: 'string[]',
};

export function defaultSettings() {
    return {
        port: 8080,
        open: false,
        allowOrigins: [],
        allowHosts: [],
        hostCheck: true,
        sigrokCli: null,
        logicAnalyzerHosts: [],
        allowAdmin: false,      // not in TYPES: command line only
    };
}

function typeOf(value) {
    if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? 'string[]' : 'array';
    return typeof value;
}

/** Apply the contents of a settings.json (as an object) to settings. */
export function applySettingsJson(settings, json, file = 'settings.json') {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error(`${file}: must be a JSON object`);
    for (const [key, value] of Object.entries(json)) {
        if (!(key in TYPES)) {
            console.warn(`${file}: unknown setting "${key}" ignored (known: ${Object.keys(TYPES).join(', ')})`);
            continue;
        }
        if (typeOf(value) !== TYPES[key]) throw new Error(`${file}: "${key}" must be a ${TYPES[key]}`);
        settings[key] = value;
    }
    return settings;
}

/** Apply the command line arguments to settings. */
export function applyArgs(settings, argv) {
    const value = (i) => {
        if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--port': settings.port = Number(value(i)); i++; break;
            case '--open': settings.open = true; break;
            case '--allow-origin': settings.allowOrigins = [...settings.allowOrigins, value(i)]; i++; break;
            case '--allow-host': settings.allowHosts = [...settings.allowHosts, value(i)]; i++; break;
            case '--no-host-check': settings.hostCheck = false; break;
            case '--allow-admin': settings.allowAdmin = true; break;
            case '--settings': i++; break;                      // read by loadSettings()
            default: console.warn(`unknown argument ${argv[i]} ignored`);
        }
    }
    return settings;
}

export function loadSettings(argv, defaultFile) {
    const settingsIndex = argv.indexOf('--settings');
    const file = settingsIndex !== -1 ? argv[settingsIndex + 1] : defaultFile;
    const settings = defaultSettings();

    if (file && existsSync(file)) {
        let json;
        try {
            json = JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
            throw new Error(`${file}: ${err.message}`);
        }
        applySettingsJson(settings, json, file);
        settings.file = file;
    } else if (settingsIndex !== -1) {
        throw new Error(`settings file not found: ${file}`);
    }

    applyArgs(settings, argv);

    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
        throw new Error('Invalid port number');
    return settings;
}

/* ============================== access checks ============================== */

/** "example.com:8080" -> "example.com", "[::1]:8080" -> "::1" (lower case), undefined when it is not a host. */
export function hostname(hostHeader) {
    const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader) ?? /^([^:[\]]+)(?::\d+)?$/.exec(hostHeader);
    return m?.[1].toLowerCase();
}

/** The names this computer is reached by: loopback, its own name, the addresses of its network interfaces. */
export function localHostnames() {
    const name = os.hostname().toLowerCase();
    const names = new Set(['localhost', '127.0.0.1', '::1', name, name + '.local']);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) names.add(a.address.toLowerCase());
    }
    return names;
}

/**
 * Is the request for this computer? The Host header is the name the browser used to reach the backend: a page
 * that rebinds its own DNS name to this computer (DNS rebinding) still sends that name, and is refused here.
 */
export function isHostAllowed(req, settings) {
    if (!settings.hostCheck) return true;
    const host = req.headers.host;
    if (!host) return true;                                     // not a browser: browsers always send Host
    const name = hostname(host);
    if (!name) return false;
    return name.endsWith('.localhost')                          // browsers resolve *.localhost to loopback themselves
        || localHostnames().has(name)
        || settings.allowHosts.some((h) => h.toLowerCase() === name);
}

/**
 * May the page that sent the request use this backend? Pages served by this backend itself and non-browser
 * clients (no Origin header) may, other pages only when their origin is in allowOrigins ("*" = any page).
 * Only safe together with isHostAllowed(): without it a rebound page passes the same-host test.
 */
export function isOriginAllowed(req, settings) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (settings.allowOrigins.includes('*') || settings.allowOrigins.includes(origin)) return true;
    try {
        return new URL(origin).host === req.headers.host;       // the page this backend served
    } catch {
        return false;
    }
}
