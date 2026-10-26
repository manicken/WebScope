/**
 * sources.js — capture sources. DemoSource generates a synthetic capture so you can test
 * with no hardware; WebSocketSource is the reference client for your Rust gateway.
 *
 * WebSocketSource protocol (adjust to match your backend):
 *   client -> server: {"type":"start","samplerate":N,"channels":N,"samples":N}  (JSON text)
 *   server -> client: {"type":"info","samplerate":N,"channels":N}               (JSON text, once)
 *   server -> client: binary frames, each a run of little-endian uint32 sample words,
 *                      appended in order to the capture buffer
 *   server -> client: {"type":"done","samples":N} | {"type":"error","message":"..."}
 *
 * Selecting a device sets appState.channels and appState.captureSettings from the device's info.
 */
(function (WS) {
    'use strict';
    const { appState, makeChannels } = WS;

    const devices = new Map(); // id -> device info, see DemoSource.info()
    let selectedDevice = null;

    let deviceSelect_el = document.getElementById("deviceSelect");
    deviceSelect_el.onchange = deviceSelected;
    deviceSelect_el.onclick = deviceSelected;

    let refresh_cb = () => {};

    document.getElementById("devicesRefreshBtn").onclick = () => {
        refresh();
    };

    function clearDevicesList() {
        deviceSelect_el.innerHTML = "";
        devices.clear();
    }

    function addDevice(device) {
        if (devices.has(device.id)) return;
        devices.set(device.id, device);
        appendNewElement(deviceSelect_el, 'option', {textContent:device.name, value:device.id});
        deviceSelect_el.value = device.id;
        deviceSelect_el.value = DemoSource.info().id; // development only
        deviceSelected();
    }

    function deviceSelected(e) {
        const device = devices.get(deviceSelect_el.value);
        if (!device || device === selectedDevice) return;
        selectedDevice = device;

        appState.channels.set(makeChannels({items:device.channels}));
        const s = appState.captureSettings;
        s.deviceName.set(device.name);
        s.samplerates.set(device.samplerates);
        s.samplerate.set(device.samplerates.at(-1));
        s.mode.set('looping');
        s.trigger.set({ channel: 0, type: 'L2H', pulseWidth: 1e-5, conditions: {} });
        s.preTrigger.set(1);    // seconds
        s.postTrigger.set(1);
        s.memoryMB.set(1024);
    }

    function refresh() {
        clearDevicesList();
        selectedDevice = null;
        addDevice(DemoSource.info());
        refresh_cb();
    }

    function setRefreshCallback(cb) {
        refresh_cb = cb;
    }

    function getSelectedId() {
        return selectedDevice?.id;
    }

    function getSelectedInfo() {
        return selectedDevice;
    }

    WS.sources = { setRefreshCallback, addDevice, refresh, getSelectedId, getSelectedInfo };
})(window.WS = window.WS || {});
