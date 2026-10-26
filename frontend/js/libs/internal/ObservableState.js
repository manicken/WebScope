
class ObservableState {
    #state;
    #subscribers = new Set();
    #batch = null;

    constructor(initialState = {}) {
        this.#state = structuredClone(initialState);
    }

    get(path) {
        if (!path) return this.#state;

        return path.split('.').reduce(
            (obj, key) => obj?.[key],
            this.#state
        );
    }

    set(path, value, source = null) {
        const keys = Array.isArray(path) ? path : path.split('.');
        const key = keys.at(-1);

        let target = this.#state;

        for (const part of keys.slice(0, -1)) {
            target = target?.[part];
            if (target == null) return false;
        }

        const oldValue = target[key];

        if (Object.is(oldValue, value)) return false;

        target[key] = value;

        this.#record({
            path: keys.join('.'),
            key,
            oldValue,
            value,
            source
        });

        return true;
    }

    update(path, patch, source = null) {
        const current = this.get(path);
        if (!current || typeof current !== 'object') return false;

        let changed = false;

        for (const [key, value] of Object.entries(patch)) {
            changed = this.set(`${path}.${key}`, value, source) || changed;
        }

        return changed;
    }

    subscribe(path, callback) {
        if (typeof path === 'function') {
            callback = path;
            path = null;
        }

        const sub = { path, callback };
        this.#subscribers.add(sub);

        return () => this.#subscribers.delete(sub);
    }

    batch(callback, source = null) {
        if (this.#batch) {
            callback();
            return;
        }

        this.#batch = [];

        try {
            callback();
        } finally {
            const changes = this.#batch;
            this.#batch = null;

            if (changes.length) {
                this.#notify(changes, source);
            }
        }
    }

    #record(change) {
        if (this.#batch) {
            this.#batch.push(change);
        } else {
            this.#notify([change]);
        }
    }

    #notify(changes, source = null) {
        const event = {
            state: this.#state,
            changes,
            source
        };

        for (const { path, callback } of this.#subscribers) {
            const relevant = path
                ? changes.filter(c =>
                    c.path === path ||
                    c.path.startsWith(path + '.') ||
                    path.startsWith(c.path + '.')
                )
                : changes;

            if (relevant.length) {
                callback({
                    ...event,
                    changes: relevant
                });
            }
        }
    }
}
