async function loadWebScopeProjectFile(filedata) {
    let zip = null;
    let projectData = {};
    try {
        zip = readZip(filedata);
        projectData = JSON.parse(await zip.readText("project.json"));
    } catch (ex) {
        InfoDialog.Show({title:"Load error", message:"Error while loading the project.\n"+ ex.message});
        return;
    }
    if (projectData.format !== "WebScope") {
        InfoDialog.Show({title:"Load error", message:"Invalid project format"});
        return;
    }

    if (!Number.isInteger(projectData.version) || projectData.version < 1 || projectData.version > 1) {
        InfoDialog.Show({title:"Load error", message:`Unsupported project version: ${projectData.version}`});
        return;
    }
    try {
        const srFileData = await zip.read("sigrok.sr");
        await loadSamplesFromSigrokFile({filedata:srFileData, decode:false});
    } catch (ex) {
        InfoDialog.Show({title:"Load error", message:"Error while loading sigrok.sr from the project.\n"+ ex.message});
        loadDecoderStates([]);
        window.WS.store.set({markerList:[], selections:[]});
        return;
    }
    try {
        const decoders = zip.has('decoders.json') ? JSON.parse(await zip.readText('decoders.json')) : [];
        loadDecoderStates(decoders);
    } catch (ex) {
        loadDecoderStates([]);
        InfoDialog.Show({title:"Load error", message:"Error while parsing decoders.json from the project.\n"+ ex.message})
    }
    let markerList = [];
    let selections = [];
    try {
        markerList = zip.has("markers.json") ? JSON.parse(await zip.readText("markers.json")) : [];
    } catch (ex) {
        InfoDialog.Show({title:"Load error", message:"Error while parsing markers.json from the project.\n"+ ex.message})
    }
    try {
        selections = zip.has("selections.json") ? JSON.parse(await zip.readText("selections.json")) : [];
    } catch (ex) {
        InfoDialog.Show({title:"Load error", message:"Error while parsing selections.json from the project.\n"+ ex.message})
    }
    window.WS.store.set({markerList, selections});

    //console.log(decoderData);
}

async function getSaveData() {
    const store = window.WS.store.get();
    let decoders =  store.decoders??[];
    //console.log(decoders);
    let decodersSave = [];
    for (let d of decoders) {
        decodersSave.push(d.getState());
    }
    let project = {
        format:"WebScope",
        version:1
    };
    
    const encoder = new TextEncoder();
    const json = data => encoder.encode(JSON.stringify(data, null, 4));
    const entries = [
        { name: "sigrok.sr", data: await getSigrokData() }, // helpers.js
        { name: "decoders.json", data: json(decodersSave) },
        { name: "project.json", data: json(project) },
        { name: "markers.json", data: json(store.markerList ?? []) },
        { name: "selections.json", data: json(store.selections ?? []) },
    ];
    let data = await writeZip(entries, { compress: true });
    return data;
}