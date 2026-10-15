async function loadWebScopeProjectFile(filedata) {
    const zip = readZip(filedata);
    const projectData = JSON.parse(await zip.readText("project.json"));

    if (projectData.format !== "WebScope")
        throw new Error("Invalid project format");

    if (projectData.version > 1)
        throw new Error(`Unsupported project version: ${projectData.version}`);

    const srFileData = await zip.read("sigrok.sr");
    await loadSamplesFromSigrokFile({filedata:srFileData, decode:false});
    const decodersJsonData = await zip.readText('decoders.json');
    const decoderData = JSON.parse(decodersJsonData);
    loadDecoderStates(decoderData);
    //console.log(decoderData);
}

async function getSaveData() {
    let decoders =  window.WS.store.get().decoders;
    console.log(decoders);
    let save = [];
    for (let d of decoders) {
        save.push(d.getState());
    }
    let jsonString = JSON.stringify(save, null, 4);
    console.log(jsonString);
    let buf = window.WS.capture.getBuffer();

    let sigrokData = await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples});
    const enc = new TextEncoder();
    const entries = [
        { name: "sigrok.sr", data: sigrokData },
        { name: "decoders.json", data: enc.encode(jsonString) },
        { name: "project.json", data: enc.encode(JSON.stringify({format:"WebScope", version:1}, null, 4)) },
    ];
    let data = await writeZip(entries, { compress: true });
    return data;
}