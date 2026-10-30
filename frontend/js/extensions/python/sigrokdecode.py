"""
sigrokdecode.py - the `sigrokdecode` module of libsigrokdecode (protocol decoder API version 3),
in Python, so upstream sigrok decoders run unchanged in WebScope's Python extension.

The C library does this with a Decoder type (type_decoder.c) and the sample matching of wait()
(instance.c). Here:
  - wait() hands its conditions to a matcher in the worker (SrdMatcher in pyWorker.js), which scans
    the capture the way instance.c does; Python only runs again when a condition matched. The
    conditions go as their repr() (made in C, so cheap), the matcher parses and caches them.
  - put() goes to the instance's sink (ws_srd_runner.py), which collects the annotations and the
    Python output for the decoders stacked on this one.
At the end of the data wait() raises EOFError, as libsigrokdecode does at the end of a session.
"""

OUTPUT_ANN = 0
OUTPUT_PYTHON = 1
OUTPUT_BINARY = 2
OUTPUT_LOGIC = 3
OUTPUT_META = 4

SRD_CONF_SAMPLERATE = 10000


class Decoder:
    """Base class of the protocol decoders. The class attributes are the decoder's metadata,
    the runner sets the instance's options, channels, matcher and sink before calling __init__()."""
    api_version = 3
    id = ''
    name = ''
    longname = ''
    desc = ''
    license = ''
    inputs = []
    outputs = []
    tags = []
    channels = ()
    optional_channels = ()
    options = ()
    annotations = ()
    annotation_rows = ()
    binary = ()

    samplenum = 0
    matched = None

    def register(self, output_type, proto_id=None, meta=None):
        """Returns the output id to pass to put()."""
        return self._srd_sink.register(output_type, proto_id or self.id, meta)

    def put(self, startsample, endsample, output_id, data):
        self._srd_sink.put(int(startsample), int(endsample), output_id, data)

    def has_channel(self, index):
        bits = self._srd_bits
        return 0 <= index < len(bits) and bits[index] >= 0

    def wait(self, conds=None):
        m = self._srd_matcher
        if m is None:
            raise Exception('wait() is only available to decoders with logic input')
        samplenum = m.wait(repr(conds))
        if samplenum < 0:
            self.samplenum = m.length
            raise EOFError('samples exhausted')
        self.samplenum = samplenum

        # state: the sample value in the low 32 bits, (mask << 6 | count) above (see SrdMatcher.state)
        state = m.state
        if state < 0:
            key, value = (m.mask << 6) | m.count, m.value
        else:
            key, value = state >> 32, state & 0xffffffff
        if key & 63 == 0:
            self.matched = None
        else:
            matched = self._srd_matched.get(key)
            if matched is None:
                mask, count = key >> 6, key & 63
                matched = self._srd_matched[key] = tuple(bool((mask >> i) & 1) for i in range(count))
            self.matched = matched

        pins = self._srd_pins.get(value)
        if pins is None:
            pins = self._srd_pins[value] = tuple(0xff if bit < 0 else (value >> bit) & 1 for bit in self._srd_bits)
        return pins
