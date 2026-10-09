class AceEditor extends AppWindow {
    constructor({ title = "Ace Editor", singleton = false, aceTheme = "textmate", aceMode = "text" } = {}) {
        super({ title, singleton, resizable: true });

        this.body_el.innerHTML = "";
        
		setStyles(this.body_el, { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: '6px', boxSizing: 'border-box' });
        
		this.header_el = appendNewElement(this.body_el, 'div', { styles: { width: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '4px' } });
        
		this.aceEditor_el = appendNewElement(this.body_el, 'div', { styles: { width: '100%', height: '100%', boxSizing: 'border-box' } });
        this.aceEditor = ace.edit(this.aceEditor_el);
        this.aceEditor.setOptions({ /*navigateWithinSoftTabs: true,*/ scrollPastEnd: 1 });
        this.aceEditor.setTheme("ace/theme/" + aceTheme);
        this.aceEditor.session.setMode("ace/mode/" + aceMode);
        this.setStates({height: 600, width: 500});
    }
}