
function SelectFile({filters=['*/*'], onRead=()=>{}}={}) {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = filters.join(',');

    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;

        console.log(file.name, file.size);
        
        let index = -1;
        let extension = ""
        let filename = file.name.toLowerCase();
        for (let ext of filters) { index = filename.lastIndexOf(ext); if (index !=-1) break; };
        if (index == -1) {
            index = file.name.lastIndexOf('.');
        }
        extension = file.name.substring(index);
        filename = file.name.substring(0, index);
         

        // Läs filen
        const reader = new FileReader();

        
        reader.onload = () => onRead({data:reader.result, name:filename, ext:extension});
        reader.onerror = () => console.error('Failed to read file:', reader.error);
        console.log("trying to read:",{name:filename, ext:extension});
        reader.readAsArrayBuffer(file);
    };

    input.click();
}