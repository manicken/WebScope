# Python runtime

[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) for WebScope's Python extension, kept
here so it works offline. The backend serves this folder read only at `/python/runtime/`; it is only
downloaded when a **Python (sigrok)** decoder is used.

`pyodide/` holds the runtime of the version in `pyodide/package.json` (Pyodide is licensed under the
Mozilla Public License 2.0, see https://github.com/pyodide/pyodide). Only the runtime and the standard
library are kept: the sigrok decoders need no other packages.

## Another location

The page parameter `pyruntime` points WebScope to another copy, e.g. a CDN:

    http://localhost:8080/?pyruntime=https://cdn.jsdelivr.net/pyodide/v314.0.7/full/

(`pydecoders` does the same for the decoder folders.)

## Updating

    node python_runtime/update-pyodide.mjs <version>

replaces `pyodide/` with that release (from npm). Then run `node python_decoders/build-index.mjs` to
check that all decoders still load.
