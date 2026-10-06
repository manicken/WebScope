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
 */
(function (WS) {
    'use strict';

    let devices = new Map();
    let selectedDevice = null;
    let deviceSelect_el = document.getElementById("deviceSelect");
    let samplerateIn_el = document.getElementById("samplerateIn");
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
        selectedDevice = device;
        deviceSelect_el.value = device.id;
    }

    function deviceSelected(e) {
        let id = deviceSelect_el.value;
        
        selectedDevice = devices.get(id);
        console.log(selectedDevice);
        //for (let rate of selectedDevice.)
        samplerateIn_el
        console.log(selectedDevice);
    }

    function refresh() {
        clearDevicesList();
        addDevice(DemoSource.info());
        refresh_cb();
    }

    function setRefreshCallback(cb) {
        refresh_cb = cb;
    }

    function getSelected() {
        return selectedDevice.sourceKind;
    }

    function getSelectedId() {
        return selectedDevice.id;
    }

    function getSelectedInfo() {
        return selectedDevice;
    }

    WS.sources = { setRefreshCallback, addDevice, refresh, getSelected, getSelectedId, getSelectedInfo };
})(window.WS = window.WS || {});
