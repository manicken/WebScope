/**
 * captureLimits.js — what a device can capture with the current settings, worked out before the
 * capture starts, so the Capture panel can gray out what is not possible and say why.
 *
 * A device describes itself with info.limits (left out = streams at any samplerate, triggered in software):
 *   stream                false: the device only captures into its own memory (it cannot run continuously)
 *   streamBytesPerSecond  the most it can send continuously; a sample = ceil(captured channels / 8) bytes
 *   memory                [{ below, samples }]: the device's own memory, in samples, when the highest
 *                         captured channel index is < below (wider samples fit fewer); first match wins
 *   preTriggerShare       the part of the memory that can be before the trigger
 *   hardwareTrigger       { types: ['L2H', ...], conditions: bool }: the device triggers itself
 *   buffer                [{ below, samples }] like memory, for a device that streams: a capture of a set
 *                         length (Timer) that fits it works at any samplerate, a longer one is streamed
 *   maxSamplerate         [{ below, samplerate }]: above it the device is not reliable (a warning, not a limit)
 *
 * A trigger the device has in hardware is used (the device sends only the capture), any other trigger
 * runs in software on the stream (backend/trigger.js), which needs a device that can stream at the samplerate.
 */
(function (WS) {
  'use strict';
  const { fmtTime, fmtRate } = WS.format;

  /**
   * @param limits  device info.limits, or null
   * @param s       { samplerate, activeChannels (device indexes), mode, triggerType, timerSeconds, preTrigger, postTrigger }
   * @returns {{ modes: Object<string, string|null>, triggerTypes: Object<string, string|null>, conditions: string|null,
   *             note: string|null, bad: boolean, maxSamples: number|null, hardware: boolean }}
   *   modes / triggerTypes / conditions: null = possible, else why not; note: about the current mode's limits,
   *   bad: the note says the current settings will not work as they are
   */
  function captureLimits(limits, s) {
    const rate = s.samplerate, channels = s.activeChannels;
    const bytes = Math.max(1, Math.ceil(channels.length / 8));
    const highest = channels.length ? Math.max(...channels) : 0;

    let noStream = null;
    if (limits?.stream === false) noStream = 'The device only captures into its own memory, it cannot stream';
    else if (limits?.streamBytesPerSecond && rate * bytes > limits.streamBytesPerSecond) {
      const maxRate = Math.floor(limits.streamBytesPerSecond / bytes);
      noStream = `The device can stream at most ${fmtRate(maxRate)} with ${channels.length} channels`;
    }

    const byHighest = (list) => list?.find((m) => highest < m.below) ?? null;
    const samples = (n) => `${n} samples = ${fmtTime(n / rate, 3)} at ${fmtRate(rate)}`;
    const memory = byHighest(limits?.memory)?.samples ?? null;
    const inMemory = memory && rate ? samples(memory) : null;
    const buffer = byHighest(limits?.buffer)?.samples ?? null;
    const fitsBuffer = buffer !== null && s.timerSeconds * rate <= buffer;
    const hw = limits?.hardwareTrigger ?? null;
    const names = { L2H: 'rising edges', H2L: 'falling edges', PulseH: 'high pulses', PulseL: 'low pulses' };
    // a trigger the device does not have runs in software, on the stream
    const notInHardware = hw && `The device triggers only on ${hw.types.map((t) => names[t]).join(' and ')}` +
      (limits.stream === false ? '' : ` at ${fmtRate(rate)}`);
    const triggerTypes = Object.fromEntries(Object.keys(names).map((t) =>
      [t, hw?.types.includes(t) || !noStream ? null : notInHardware || noStream]));
    const hardware = !!hw?.types.includes(s.triggerType);
    const modes = {
      looping: noStream,
      oneshot: memory ? null : noStream,
      timer: memory || buffer ? null : noStream,      // a shorter capture fits: the note says how short
      trigger: Object.values(triggerTypes).every(Boolean) ? noStream : null,
    };
    // conditions only for a trigger that runs in software, or a device that checks them itself
    const conditions = hardware ? (hw.conditions ? null : 'The device cannot check other channels when it triggers')
      : triggerTypes[s.triggerType];

    // the device's memory limits a capture that goes through it: not streaming, or a hardware trigger
    let note = null, maxSamples = null, bad = false;
    const viaMemory = memory && (s.mode === 'trigger' ? hardware : noStream);
    if (viaMemory) {
      maxSamples = memory;
      if (s.mode === 'oneshot') note = `Fills the device's memory: ${inMemory}`;
      if (s.mode === 'timer') {
        note = `At most ${inMemory}`;
        if (s.timerSeconds * rate > memory) { note += '. The capture will be shortened'; bad = true; }
      }
      if (s.mode === 'trigger') {
        const maxPre = Math.floor(memory * (limits.preTriggerShare ?? 1)) - 1;
        note = `At most ${fmtTime(maxPre / rate, 3)} before the trigger, ${inMemory} in all`;
        if (Math.round(s.preTrigger * rate) > maxPre || Math.round((s.preTrigger + s.postTrigger) * rate) + 1 > memory) { note += '. Too long for the device'; bad = true; }
      }
    }
    if (buffer && s.mode === 'timer') {
      if (fitsBuffer) note = `Fits the board's buffer (${samples(buffer)}): works at any samplerate`;
      else if (noStream) { note = `${noStream}: at most ${samples(buffer)}, which fits the board's buffer`; bad = true; }
      else note = `Longer than the board's buffer (${samples(buffer)}): it is streamed, which can stop early at high samplerates`;
    }
    const maxRate = byHighest(limits?.maxSamplerate)?.samplerate;
    if (maxRate && rate > maxRate) {
      note = (note ? note + '. ' : '') + `With these channels the device is reliable up to ${fmtRate(maxRate)} only`;
      bad = true;
    }
    const problem = modes[s.mode] ?? (s.mode === 'trigger' ? triggerTypes[s.triggerType] : null);
    return { modes, triggerTypes, conditions, note: problem ?? note, bad: !!problem || bad, maxSamples, hardware };
  }

  /** captureLimits() for appState.captureSettings as they are now. */
  function currentLimits() {
    const s = WS.appState.captureSettings;
    return captureLimits(s.limits.value, {
      samplerate: s.samplerate.value, activeChannels: s.activeChannels.value, mode: s.mode.value, triggerType: s.trigger.value.type,
      timerSeconds: s.timerSeconds.value, preTrigger: s.preTrigger.value, postTrigger: s.postTrigger.value,
    });
  }

  WS.captureLimits = captureLimits;
  WS.currentLimits = currentLimits;
})(window.WS = window.WS || {});
