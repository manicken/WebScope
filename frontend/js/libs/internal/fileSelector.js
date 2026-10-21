
//function SelectFile({filters=['*/*'], multiple=false, onRead=()=>{}}={}) {
/*    const input = document.createElement('input');

    input.type = 'file';
    input.accept = filters.join(',');
    if (multiple) {
        input.multiple = true;
    }

    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;

        //console.log(file.name, file.size);
        
        let index = -1;
        let extension = ""
        let filename = file.name.toLowerCase();
        for (let ext of filters) { index = filename.lastIndexOf(ext); if (index !=-1) break; };
        if (index == -1) {
            index = file.name.lastIndexOf('.');
        }
        extension = file.name.substring(index+1);
        filename = file.name.substring(0, index);
         

        // Läs filen
        const reader = new FileReader();

        
        reader.onload = () => onRead({data:reader.result, name:filename, ext:extension});
        reader.onerror = () => console.error('Failed to read file:', reader.error);
        //console.log("trying to read:",{name:filename, ext:extension});
        reader.readAsArrayBuffer(file);
    };

    input.click();
}*/

function SelectFile({filters=['*/*'], multiple=false, onRead=()=>{}}={}) {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = filters.join(',');
    input.multiple = multiple;

    input.onchange = async () => {
        const files = Array.from(input.files);
        if (!files.length) return;

        const results = await Promise.all(files.map(file => {
            let index = -1;
            let extension = "";
            let filename = file.name.toLowerCase();

            for (let ext of filters) {
                index = filename.lastIndexOf(ext);
                if (index != -1) break;
            }

            if (index == -1) {
                index = file.name.lastIndexOf('.');
            }

            extension = file.name.substring(index + 1);
            filename = file.name.substring(0, index);

            return new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = () => resolve({
                    data: reader.result,
                    name: filename,
                    ext: extension
                });

                reader.onerror = () => reject(reader.error);

                reader.readAsArrayBuffer(file);
            });
        }));

        onRead(multiple ? results : results[0]);
    };

    input.click();
}