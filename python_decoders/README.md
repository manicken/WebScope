# Python decoders

The protocol decoders of WebScope's Python extension: sigrok's decoders, run unchanged in the
browser (Pyodide). In WebScope add the decoder **Python (sigrok)** and choose one of them in its
settings. The backend serves this folder read only at `/python/decoders/`.

| Folder    | What                                                                                 |
|-----------|--------------------------------------------------------------------------------------|
| `sigrok/` | The decoders of [libsigrokdecode](https://github.com/sigrokproject/libsigrokdecode), unchanged. `VERSION` is the commit, `COPYING` their license (GPL). |
| `user/`   | Your own decoders, or other versions of sigrok's: a decoder here replaces the one of the same name in `sigrok/`. |

## Adding a decoder

Copy the decoder's folder (e.g. `mydecoder/` with `__init__.py` and `pd.py`) into `user/`. WebScope
finds it from the folder listing; it imports it the first time it is chosen. A decoder in `user/`
can use sigrok's helpers (`from common.srdhelper import ...`).

Optionally index it, so WebScope shows its name and settings without importing it first:

    node python_decoders/build-index.mjs user

## index.json

`build-index.mjs` imports every decoder of a folder (with the same code WebScope runs, in the Pyodide
of `python_runtime/`, so no local Python is needed) and writes their metadata (name, channels,
options, annotation rows, inputs and outputs) to the folder's `index.json`. Decoders that fail to
import are listed under `errors`.

## Updating the sigrok decoders

    node python_decoders/update-sigrok.mjs <libsigrokdecode commit>

replaces `sigrok/` with the decoders of that commit and rebuilds `sigrok/index.json`.
