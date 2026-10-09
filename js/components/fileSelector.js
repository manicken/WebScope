
function SelectFile({filter='*/*', onRead=()=>{}}={}) {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = filter; //'.sr,.sal,.json';

    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;

        console.log(file.name, file.size);

        // Läs filen
        const reader = new FileReader();
        reader.onload = () => onRead(reader.result, file);
        reader.onerror = () => console.error('Failed to read file:', reader.error);
        reader.readAsArrayBuffer(file);
    };

    input.click();
}