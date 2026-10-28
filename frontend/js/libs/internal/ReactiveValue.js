/**
 * ReactiveValue.js — one value that tells its subscribers when it is written.
 *
 *   const visible = new ReactiveValue(true);
 *   visible.subscribe(({ value, source }) => { if (source !== checkbox) checkbox.checked = value; });
 *   visible.set(false, checkbox);       // the writer passes itself as source to recognise its own change
 *
 * set() only notifies when the value actually changed (Object.is), so arrays and objects must be
 * replaced, not changed in place:  list.set([...list.value, item])
 *
 * subscribe() returns a function that ends the subscription: something that lives shorter than the
 * value (e.g. a window that is destroyed) must call it, else the value keeps it alive and calls it.
 */
class ReactiveValue {
    #value;
    #subs = new Set();

    constructor(value) {
        this.#value = value;
    }

    get value() { return this.#value; }

    set(value, source = null) {
        if (Object.is(this.#value, value)) return;
        this.#value = value;
        const args = { state: this, value, source };
        [...this.#subs].forEach(fn => fn(args)); // a copy, so a callback may subscribe without looping
    }

    subscribe(fn) {
        this.#subs.add(fn);
        return () => this.#subs.delete(fn);
    }

    /** Calls `fn` when any of `values` changes. */
    static subscribeAll(values, fn) {
        values.forEach(v => v.subscribe(fn));
    }

    /**
     * Calls `fn` when the list changes and when one of the values `pick(item)` returns changes,
     * for every item that is, or later gets, in the list. Each item is subscribed only once.
     *   ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.visible], relayout);
     */
    static subscribeItems(list, pick, fn) {
        const seen = new WeakSet();
        const hook = (items) => items.forEach(item => {
            if (seen.has(item)) return;
            seen.add(item);
            pick(item).forEach(v => v.subscribe(fn));
        });
        list.subscribe(args => { hook(args.value); fn(args); });
        hook(list.value);
    }
}
