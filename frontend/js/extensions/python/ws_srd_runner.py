"""
ws_srd_runner.py - runs sigrok protocol decoders for WebScope's PythonDecoder (see pyWorker.js).

  install(roots)          decoder folders to import from: [{ 'url', 'names' }], first wins; 'names' is
                          the folder's listing (top level), or None when it cannot be listed
  metadata(name)          JSON: the metadata of decoder package `name` (the folder name)
  run(job, matcher)       JSON: decodes one PythonDecoder instance, see run()

Decoder packages and their imports (e.g. common.srdhelper) are fetched when Python imports them,
written to the in-memory file system and imported from there, so only what is used is downloaded.

Stacking works as in libsigrokdecode: what a decoder put() as OUTPUT_PYTHON is fed to the decoders
stacked on it, as decode(startsample, endsample, data). Each instance runs in its own job, so the
Python output of the last run of every instance is kept here and replayed to its stacked decoders.
"""
import importlib
import importlib.abc
import importlib.util
import json
import math
import os
import sys
import traceback

import sigrokdecode as srd
import _wshost

FS_ROOT = '/srd'


class _Finder(importlib.abc.MetaPathFinder):
    """Imports modules from the decoder folders over HTTP (after the standard library, so a missing
    module only costs requests when no other finder has it)."""

    def __init__(self, roots):
        self.roots = roots

    def find_spec(self, fullname, path=None, target=None):
        parts = fullname.split('.')
        rel = '/'.join(parts)
        package_first = len(parts) == 1        # decoders are packages, their modules mostly files
        candidates = [(rel + '/__init__.py', True), (rel + '.py', False)]
        if not package_first:
            candidates.reverse()
        for i, root in enumerate(self.roots):
            names = root.get('names')
            if names is not None and parts[0] not in names:
                continue
            for file, is_package in candidates:
                text = _wshost.fetch_text(root['url'] + file)
                if not isinstance(text, str):
                    continue
                fs_path = '%s/r%d/%s' % (FS_ROOT, i, file)
                os.makedirs(os.path.dirname(fs_path), exist_ok=True)
                with open(fs_path, 'w', encoding='utf-8') as f:
                    f.write(text)
                return importlib.util.spec_from_file_location(
                    fullname, fs_path,
                    submodule_search_locations=[os.path.dirname(fs_path)] if is_package else None)
        return None


_finder = None
_recordings = {}         # instance id -> (generation, [(startsample, endsample, data), ...])


def install(roots_json):
    global _finder
    roots = json.loads(roots_json)
    for root in roots:
        if root.get('names') is not None:
            root['names'] = set(root['names'])
    if _finder is None:
        _finder = _Finder(roots)
        sys.meta_path.append(_finder)
    else:
        _finder.roots = roots


def _plain(o):
    """`o` as JSON data: tuples become lists, bytes lists of numbers, other objects their repr()."""
    if o is None or isinstance(o, (bool, str)):
        return o
    if isinstance(o, int):
        return o
    if isinstance(o, float):
        return o if math.isfinite(o) else repr(o)
    if isinstance(o, (bytes, bytearray)):
        return list(o)
    if isinstance(o, (list, tuple)):
        return [_plain(x) for x in o]
    if isinstance(o, dict):
        return {str(k): _plain(v) for k, v in o.items()}
    return repr(o)


def _dumps(o):
    """JSON of `o`; json's C encoder takes the common types, _plain() the rest (and NaN, which
    JavaScript's JSON.parse() does not take)."""
    try:
        return json.dumps(o, allow_nan=False, default=_plain_default)
    except (TypeError, ValueError):
        return json.dumps(_plain(o))


def _plain_default(o):
    if isinstance(o, (bytes, bytearray)):
        return list(o)
    return repr(o)


def _decoder_class(name):
    module = importlib.import_module(name)
    cls = getattr(module, 'Decoder', None)
    if cls is None:
        raise Exception('%s has no Decoder class' % name)
    if getattr(cls, 'api_version', None) != 3:
        raise Exception('%s: decoder API version %s is not supported (3 is)' % (name, getattr(cls, 'api_version', None)))
    return cls


def _metadata(name, cls):
    return {
        'name': name,
        'id': cls.id,
        'shortname': cls.name,
        'longname': cls.longname,
        'desc': cls.desc,
        'license': cls.license,
        'inputs': list(cls.inputs),
        'outputs': list(cls.outputs),
        'tags': list(getattr(cls, 'tags', [])),
        'channels': [{'id': c['id'], 'name': c.get('name', c['id']), 'desc': c.get('desc', '')} for c in cls.channels],
        'optional_channels': [{'id': c['id'], 'name': c.get('name', c['id']), 'desc': c.get('desc', '')} for c in cls.optional_channels],
        'options': [_plain({k: v for k, v in o.items() if k in ('id', 'desc', 'default', 'values')}) for o in cls.options],
        'annotations': [[a[0], a[1]] for a in cls.annotations],
        'annotation_rows': [[r[0], r[1], list(r[2])] for r in cls.annotation_rows],
        'binary': [[b[0], b[1]] for b in getattr(cls, 'binary', ())],
    }


def metadata(name):
    return json.dumps(_metadata(name, _decoder_class(name)))


def scan(names_json):
    """Metadata of several decoders, for the decoder index: { 'decoders': [...], 'errors': {name: text} }."""
    out, errors = [], {}
    for name in json.loads(names_json):
        try:
            out.append(_metadata(name, _decoder_class(name)))
        except Exception:
            errors[name] = traceback.format_exc(limit=3)
    return json.dumps({'decoders': out, 'errors': errors})


class _Sink:
    """What one instance put(): annotations, and its Python output when decoders may stack on it."""

    def __init__(self, ann_count):
        self.outputs = []
        self.anns = []
        self.python = []
        self.ann_count = ann_count
        self.invalid = 0

    def register(self, output_type, proto_id, meta):
        self.outputs.append(output_type)
        return len(self.outputs) - 1

    def put(self, ss, es, output_id, data):
        if not (0 <= output_id < len(self.outputs)):
            raise Exception('put(): invalid output id %r' % (output_id,))
        kind = self.outputs[output_id]
        if kind == srd.OUTPUT_ANN:
            # as convert_annotation() in libsigrokdecode: [class, [text, ...]], else ignored
            try:
                cls, texts = data
                if not (isinstance(cls, int) and 0 <= cls < self.ann_count):
                    raise ValueError
                texts = [str(t) for t in texts]
            except (TypeError, ValueError):
                self.invalid += 1
                return
            self.anns.append([ss, es, cls, texts])
        elif kind == srd.OUTPUT_PYTHON:
            self.python.append((ss, es, data))
        # OUTPUT_BINARY / OUTPUT_LOGIC / OUTPUT_META: not used by WebScope (yet)


def _coerce(option, value):
    """The user's value of an option, as the type of its default (as srd_inst_option_set())."""
    default = option['default']
    if value is None:
        return default
    try:
        if isinstance(default, bool):
            value = bool(value)
        elif isinstance(default, int):
            value = int(value)
        elif isinstance(default, float):
            value = float(value)
        else:
            value = str(value)
    except (TypeError, ValueError):
        return default
    values = option.get('values')
    if values and value not in values:
        return default
    return value


def run(job_json, matcher):
    """Decodes one instance.

    job: { inst, gen, name, options: {id: value}, bits: [capture bit or -1 per channel, optional ones
           after the required ones], samplerate, parent: null | { inst, gen } }
    matcher: the worker's wait() matcher over the capture (logic input), or None (stacked).
    Returns JSON { anns: [[ss, es, class, [texts]]], python: [[ss, es, data]], error, invalid }.
    """
    job = json.loads(job_json)
    cls = _decoder_class(job['name'])
    sink = _Sink(len(cls.annotations))
    error = None

    nch = len(cls.channels)
    bits = list(job['bits'])
    bits += [-1] * (nch + len(cls.optional_channels) - len(bits))
    missing = [cls.channels[i]['name'] for i in range(nch) if bits[i] < 0]
    parent = job.get('parent')
    if parent is None and missing:
        raise Exception('No channel chosen for: %s' % ', '.join(missing))

    inst = cls.__new__(cls)
    inst.options = {o['id']: _coerce(o, job['options'].get(o['id'])) for o in cls.options}
    inst._srd_sink = sink
    inst._srd_bits = bits
    inst._srd_matcher = matcher
    inst._srd_pins = {}
    inst._srd_matched = {}
    inst.samplenum = 0
    inst.matched = None
    inst.__init__()
    if hasattr(inst, 'metadata') and job.get('samplerate'):
        inst.metadata(srd.SRD_CONF_SAMPLERATE, int(job['samplerate']))
    if hasattr(inst, 'start'):
        inst.start()

    if parent is None:
        try:
            inst.decode()
        except EOFError:
            pass
        except Exception:
            error = traceback.format_exc(limit=-4)
    else:
        rec = _recordings.get(parent['inst'])
        if rec is None or rec[0] != parent['gen']:
            raise Exception('The parent decoder has no current output')
        failed = 0
        for ss, es, data in rec[1]:
            try:
                inst.decode(ss, es, data)
            except Exception:
                failed += 1
                if failed == 1:
                    error = traceback.format_exc(limit=-4)
        if failed > 1:
            error += '\n(decode() failed %d times)' % failed

    if cls.outputs:
        _recordings[job['inst']] = (job['gen'], sink.python)
    return _dumps({
        'anns': sink.anns,
        'python': sink.python,
        'error': error,
        'invalid': sink.invalid,
    })


def forget(inst):
    """Drops the kept output of a removed instance."""
    _recordings.pop(inst, None)
