class AppStorage {
    static #PREFIX = undefined;

    static setPrefix(prefix) {
        if (AppStorage.#PREFIX !== undefined)
            throw Error("AppStorage PREFIX is already SET");

        AppStorage.#PREFIX = prefix;
    }

    static #key(key) {
        if (AppStorage.#PREFIX === undefined) {
            throw Error("AppStorage PREFIX is not SET");
        }
        if (key.startsWith(AppStorage.#PREFIX)) return key;
        return AppStorage.#PREFIX + key;
    }

    static set(key, value) {
        localStorage.setItem(
            AppStorage.#key(key),
            typeof value === 'string'
                ? value
                : JSON.stringify(value)
        );
    }

    static get(key, defaultValue = null) {
        const value = localStorage.getItem(AppStorage.#key(key));

        if (value === null) {
            console.log("could not find the key: " + key);
            return defaultValue;
        }

        try {
            
            return JSON.parse(value);
        } catch {
            
            //console.log("could not parse as json: " + value);
            return value;
        }
    }

    static remove(key) {
        localStorage.removeItem(AppStorage.#key(key));
    }

    static has(key) {
        return localStorage.getItem(AppStorage.#key(key)) !== null;
    }

    static rename(oldKey, newKey) {
        if (oldKey === newKey) {
            return true; // nothing to do
        }
        const oldStorageKey = AppStorage.#key(oldKey);
        const newStorageKey = AppStorage.#key(newKey);

        if (localStorage.getItem(oldStorageKey) === null)
            return false;

        if (localStorage.getItem(newStorageKey) !== null)
            return false;

        localStorage.setItem(
            newStorageKey,
            localStorage.getItem(oldStorageKey)
        );

        localStorage.removeItem(oldStorageKey);

        return true;
    }

    static list(postfix = '', filter = () => true) {
        const prefix = AppStorage.#key(postfix);
        let list = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            
            if (key && key.startsWith(prefix)) {
                const subkey = key.substring(prefix.length);
                if (filter(subkey)) {
                    list.push(subkey);
                }
            }
        }
        //console.trace(list);
        return list;
    }

    static export() {
        let items = AppStorage.list();
        let dump = {};
        for (let item of items) {
            dump[item] = AppStorage.get(item);
        }
        return dump;
    }

    static import(data) {
        for (const [key, value] of Object.entries(data)) {
            AppStorage.set(key, value);
        }
    }
}

class Setting {
    static PREFIX = 'setting.';

    constructor(name, defaultValue) {
        this.name = name;
        this.value = AppStorage.get(this._key(this.name), defaultValue);
    }

    _key(key) {
        if (key.startsWith(Setting.PREFIX)) return key;
        return Setting.PREFIX + key;
    }
    /** sets and saves the setting to local storage */
    set(value) {
        this.value = value;
        this.save();
    }
    save() {
        AppStorage.set(this._key(this.name), this.value);
    }
};

class MergedSetting extends Setting {

    constructor(name, defaultValue) {
        super(name, undefined);

        if (this.value == undefined) {
            this.value = defaultValue;
        } else {
            this.value = {...defaultValue, ...this.value};
        }
    }
};

class AppStorageFileSystem {
    static #PREFIX = 'files.';

    static key(name) {
        if (name.startsWith(AppStorageFileSystem.#PREFIX)) return name;
        return AppStorageFileSystem.#PREFIX + name;
    }

    static rename(oldName, newName) {
        let oldKey = AppStorageFileSystem.key(oldName);
        let newKey = AppStorageFileSystem.key(newName);
        return AppStorage.rename(oldKey, newKey)
    }

    static exists(name) {
        return AppStorage.has(AppStorageFileSystem.key(name));
    }

    static remove(name) {
        AppStorage.remove(AppStorageFileSystem.key(name));
    }
    static list(prefix = '', filter = () => true) {
        return AppStorage.list(AppStorageFileSystem.key(prefix), filter);
    }
}

class AppStorageFile {

    constructor(name, content = '') {
        this.name = name;
        this.content = content;
    }

    save() {
        AppStorage.set(AppStorageFileSystem.key(this.name), this.content);
    }

    renameTo(name) {
        if (!AppStorageFileSystem.rename(this.name, name)) {
            return false;
        }

        this.name = name;
        return true;
    }
    /** just a shorthand for 'new AppStorageFile()' */
    static createNew(name, content = '') {
        return new AppStorageFile(name, content);
    }
    /** loads a existing file, and if it don't exist it returns a new AppStorageFile */
    static load(name) {
        const content = AppStorage.get(AppStorageFileSystem.key(name), null);

        if (content === null) {
           // console.log("content is null");
            return null;
        }
        //console.log(content);

        return new AppStorageFile(name, content);
    }
}

class AssemblyEditFile {
    static #METADATA_FILE_END = '.json';
    #removed = false;

    constructor(name, metafile, asmfile, asmFileContents = '') {
        
        this.name = name;
        this.metafile = metafile ?? AppStorageFile.createNew(name + AssemblyEditFile.#METADATA_FILE_END);
        this.asmfile = asmfile ?? AppStorageFile.createNew(name, asmFileContents);
    }
    static createNew(name, asmFileContents = '') {
        return new AssemblyEditFile(name, undefined, undefined , asmFileContents)
    }
    static load(name) {
        return new AssemblyEditFile(name, 
            AppStorageFile.load(name + AssemblyEditFile.#METADATA_FILE_END), 
            AppStorageFile.load(name), 
        );
    }
    getAsmFileContents() {
        if (this.#removed) throw Error("cannot getAsmFileContents on removed file");
        return this.asmfile.content;
    }
    setAsmFileContents(data) {
        if (this.#removed) throw Error("cannot setAsmFileContents on removed file");
        this.asmfile.content = data;
    }
    setMetaFileContents(data) {
        if (this.#removed) throw Error("cannot setMetaFileContents on removed file");
        this.metafile.content = data;
    }
    getMetaFileContents() {
        if (this.#removed) throw Error("cannot getMetaFileContents on removed file");
        return this.metafile.content;
    }
    save() {
        if (this.#removed) throw Error("cannot save on removed file");
        this.metafile.save();
        this.asmfile.save();
    }
    renameTo(name) {
        if (this.#removed) throw Error("cannot renameTo on removed file");

        if (!this.asmfile.renameTo(name)) {
            return false;
        }
        if (!this.metafile.renameTo(name + AssemblyEditFile.#METADATA_FILE_END)) {
            // this should allways pass if the first file renambe was a success
            return false;
        }
        this.name = name;
        return true;
    }
    removePermanent() {
        AppStorageFileSystem.remove(this.name);
        AppStorageFileSystem.remove(this.name + AssemblyEditFile.#METADATA_FILE_END);
        this.#removed = true;
    }
    #removePermanent() {
        
    }
}