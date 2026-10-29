// deviceSettings.js - device settings: a device describes its settings, the browser draws the form from that.
//
// Every device gets the same window (Device Information / Device Settings in the capture panel): its name,
// channels and samplerates, then optionally
//   details: [{ label: 'Firmware', value: 'V6_5' }, ...]      more read-only lines about the device
//   settings: {
//       title: 'WiFi settings',                 the window's title
//       note: 'Saved on the board.',            optional text above the fields
//       disabled: 'This board has no WiFi',     optional: the fields are shown grayed out with this reason,
//                                               and cannot be saved
//       fields: [
//           { type: 'heading', label: 'Network' },
//           { key: 'ssid', label: 'Network name', type: 'text', minLength: 1, maxLength: 32 },
//           { key: 'password', label: 'Password', type: 'password', maxLength: 63 },
//           { key: 'ip', label: 'IP address', type: 'text', pattern: '\\d+\\.\\d+\\.\\d+\\.\\d+', patternHint: 'e.g. 192.168.1.20' },
//           { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, integer: true },
//           { key: 'rate', label: 'Rate', type: 'select', options: [{ value: 9600, label: '9600 baud' }, ...] },
//           { key: 'enabled', label: 'Enabled', type: 'checkbox' },
//       ],                                      every field may also have help: 'text under the field';
//                                               pattern is a regular expression for the whole text
//       values: { ssid: '', ... },              the current values
//   }
// A device with settings that are not disabled has applySettings(values) -> Promise<{ message, info }> on its
// device kind (info: the device info with the new settings), which throws Error(message) when the values
// cannot be used.
//
// Browser -> backend: { type: 'deviceSettings', reqId, deviceId, values }
// Backend -> browser: { type: 'deviceSettings', reqId, ok, message }, then to every browser
//                     { type: 'deviceUpdated', device: info }
//
// The browser checks the same rules (frontend/js/libs/internal/AppWindows/DeviceSettingsDialog.js), but the
// backend has to check them again: anything can send it a message.

/**
 * The values checked against the settings' fields: every field's value, from `values` or else the current one.
 * Throws Error(message) naming the field.
 */
export function validateSettings(settings, values) {
    if (settings.disabled) throw new Error(settings.disabled);
    const out = {};
    for (const f of settings.fields) {
        if (!f.key) continue;                                   // a heading
        const v = values?.[f.key] ?? settings.values?.[f.key];
        const bad = (why) => new Error(`${f.label}: ${why}`);
        switch (f.type) {
            case 'number':
                if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('must be a number');
                if (f.integer && !Number.isInteger(v)) throw bad('must be a whole number');
                if (f.min !== undefined && v < f.min) throw bad(`must be at least ${f.min}`);
                if (f.max !== undefined && v > f.max) throw bad(`must be at most ${f.max}`);
                break;
            case 'text':
            case 'password':
                if (typeof v !== 'string') throw bad('must be text');
                if (f.minLength !== undefined && v.length < f.minLength) throw bad(f.minLength === 1 ? 'is needed' : `at least ${f.minLength} characters`);
                if (f.maxLength !== undefined && v.length > f.maxLength) throw bad(`at most ${f.maxLength} characters`);
                if (f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`).test(v)) throw bad(f.patternHint ?? 'wrong format');
                break;
            case 'select':
                if (!f.options.some((o) => o.value === v)) throw bad(`"${v}" is not one of the choices`);
                break;
            case 'checkbox':
                if (typeof v !== 'boolean') throw bad('must be on or off');
                break;
            default:
                throw bad(`unknown field type "${f.type}"`);
        }
        out[f.key] = v;
    }
    return out;
}
