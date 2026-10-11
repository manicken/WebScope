
class AppWindows {

    

    static Singletons = {};
    static SetAsSingleton(win) {
        let singletonID = win.constructor.TYPE;
        //console.log(singletonID);
        if (AppWindows.Singletons[singletonID] !== undefined) {
            throw new Error(`AppWindow singleton already exists: ${singletonID}`);
        }
        win.canBeDestroyed = false;
        AppWindows.Singletons[singletonID] = win;
    }

    static events = new EventTarget();
    static #AddMultipleEventListeners(callback, names) {
        for (let name of names) { AppWindows.events.addEventListener(name, callback); }
    }

    static emit(type, window) {
       // console.trace(type);
        AppWindows.events.dispatchEvent(new CustomEvent(type, { detail: { window } }));
    }

	static #AppWindowZoffset = 2000;
	static #windows = [];
    static addToList(win) {
        AppWindows.#windows.push(win);
    }
    static removeFromList(win) {
		let index = AppWindows.#windows.indexOf(win);
		if (index !== -1) { AppWindows.#windows.splice(index, 1); }
    }
    static #updateZIndexes() {
		for (let i=0; i<AppWindows.#windows.length; i++) {
			AppWindows.#windows[i].setZIndex(i*2 + AppWindows.#AppWindowZoffset);
		}
	}
	/** Bring to front in the z-stack (does not modify .state). Also works for completely new windows (indexOf -> -1). */
    static bringToFront(win) {
        AppWindows.removeFromList(win);
        AppWindows.addToList(win);
        AppWindows.#updateZIndexes();
    }
    static getActiveWindow() {
        // it's the last z-order window that is open that represent the current active window
        for (let i = AppWindows.#windows.length - 1; i >= 0; i--) {
            if (AppWindows.#windows[i].isOpen()) return AppWindows.#windows[i];
        }
        return null;
    }

	static initAppWindowManager(AppWindow_msgr_el) {
        AppWindowManager.init({
            root_el:AppWindow_msgr_el,
            events:AppWindows.events,
            onGetActiveWindow:AppWindows.getActiveWindow,
        });

        //AppWindows.#initDebugEventLoggers();
        AppWindows.#initSaveStateOnEvents();
    }
    
    static #eventNames = ['open','close','minimize','show','destroy','resized','moved'];

    static #initSaveStateOnEvents() {
        AppWindows.#AddMultipleEventListeners(() => AppWindows.saveAppWindowsState(), AppWindows.#eventNames);
    }

    static #initDebugEventLoggers() {
        AppWindows.#AddMultipleEventListeners((e) => console.trace(`AWM - window ${e.type}: ${e.detail.window.title}`), AppWindows.#eventNames)
    }

    static #Create_GotoLabelForm(states) {
        return new GotoLabelForm({
            onGotoAddress: gotoDisasmAddress,
            filters: [
                [js51_disasm.LabelType.User, "User"],
                [js51_disasm.LabelType.Func, "Functions"],
                [js51_disasm.LabelType.Jump, "Jumps"]
            ],
            onOpen:(win) => {
                win.generateList(insn_map);
            }
        }).setStates(states);
    }
    static #Create_LabelReferencesForm(states) {
        return new LabelReferencesForm({ 
            onGotoAddress: gotoDisasmAddress 
        }).setStates(states);
    }
    static #Create_SettingsEditor(states) {
        return new SettingsEditor().setStates(states);
    }
    static #Create_AssemblyViewer(states) {
        return new AssemblyViewer().setStates(states); 
    }
    static #Create_AssemblyEditor(states) {
        return new AssemblyEditor({
            onBuild: asmEditOnBuild 
        }).setStates(states); 
    }
    static #Create_XRAM_View(states) {
        return new XRAM_View().setStates(states);
    }
    static #Create_IRAM_View(states) {
        return new IRAM_View().setStates(states);
    }
    static #Create_AM29F040_FLASH_View(states) {
        return new AM29F040_FLASH_View().setStates(states);
    }
    static #Create_Profiler(states) {
        return new Profiler({
            cpu: window.app.cpu, 
            onGotoAddress: gotoDisasmAddress
        }).setStates(states);
    }
    static #Create_HexEditor(states) {
        return new HexEditor().setStates(states);
    }

    static #WindowTypes = {
        //[GotoLabelForm.TYPE]: AppWindows.#Create_GotoLabelForm,
        //[LabelReferencesForm.TYPE]: AppWindows.#Create_LabelReferencesForm,
        //[SettingsEditor.TYPE]: AppWindows.#Create_SettingsEditor,
        //[AssemblyViewer.TYPE]: AppWindows.#Create_AssemblyViewer,
        //[AssemblyEditor.TYPE]: AppWindows.#Create_AssemblyEditor,
        //[Profiler.TYPE]: AppWindows.#Create_Profiler,
        //[HexEditor.TYPE]: AppWindows.#Create_HexEditor,
        //[XRAM_View.TYPE]: AppWindows.#Create_XRAM_View,
        //[IRAM_View.TYPE]: AppWindows.#Create_IRAM_View,
        //[AM29F040_FLASH_View.TYPE]: AppWindows.#Create_AM29F040_FLASH_View,
    };
    static #decodeAndInitWindow(winState) {
        const factory = AppWindows.#WindowTypes[winState.type];

        if (!factory) {
            console.warn(`Unknown window type: ${winState.type}`);
            return;
        }

        let defaultValue = AppWindows.#GetSingletonsDefault(winState.type);
        let win = factory({...defaultValue, ...winState});
    }
    static #initWindows(items) {
        for (let i=0;i<items.length;i++) {
            AppWindows.#decodeAndInitWindow(items[i]);
        }
        const tabOrder = [...AppWindows.#windows].sort((a, b) => a.tabIndex - b.tabIndex);
        AppWindowManager.setTaskBarItems(tabOrder);
    }

    static saveAppWindowsState() {
		AppWindowManager.setTaskBarOrderIndexes();
        const winExport = AppWindows.#windows.map(win => win.getStates());
        AppWindows.PersistentStorage.set(winExport);
		//console.log(JSON.stringify(winExport, null, 4));
	}

    static #GetSingletonsDefault(type) {
        for (let item of AppWindows.#SingletonsDefaults) {
            if (item.type == type) {
                return item;
            }
        }
        return {};
    }
    
    static #SingletonsDefaults = [
        //{type:GotoLabelForm.TYPE,       width:420, height:768, mode:AppWindow.Modes.Open},
        //{type:LabelReferencesForm.TYPE, width:420, height:768},
        //{type:SettingsEditor.TYPE,      width:420, height:768},
        //{type:AssemblyViewer.TYPE,      width:420, height:768},
        //{type:Profiler.TYPE,            width:800, height:768},
        //{type:HexEditor.TYPE,           width:700, height:768},
    ];
    static PersistentStorage = undefined;

    static initSingletonAppWindows() {
        
        AppWindows.PersistentStorage = new Setting('AppWindows', AppWindows.#SingletonsDefaults)

        console.log(AppWindows.PersistentStorage.value);
        AppWindows.#initWindows(AppWindows.PersistentStorage.value);
    }

}

