import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoundStyleEngine, type SoundStyleEngineEvent } from './engine.js';
import type { SoundStyleSpecification } from './types.js';

function createAudioParam(initial: number) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function createFakeNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createFakeAudioContext() {
  const destination = createFakeNode();
  const masterGain = { ...createFakeNode(), gain: createAudioParam(1) };

  const createdBufferSources: Array<{
    buffer: AudioBuffer | null;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
    playbackRate: { value: number };
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  const audioContext = {
    destination,
    currentTime: 0,
    createGain: vi.fn(() => ({ ...createFakeNode(), gain: createAudioParam(1) })),
    createStereoPanner: vi.fn(() => ({ ...createFakeNode(), pan: createAudioParam(0) })),
    createBiquadFilter: vi.fn(() => ({
      ...createFakeNode(),
      type: 'lowpass',
      frequency: createAudioParam(22050),
    })),
    createBufferSource: vi.fn(() => {
      const node = {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: createAudioParam(1),
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      createdBufferSources.push(node);
      return node;
    }),
    decodeAudioData: vi.fn().mockResolvedValue({ duration: 1 } as AudioBuffer),
    createMediaElementSource: vi.fn((element: HTMLAudioElement) => ({ ...createFakeNode(), mediaElement: element })),
  };

  const createdGainNodes: Array<{ gain: ReturnType<typeof createAudioParam> }> = [];
  audioContext.createGain.mockImplementation(() => {
    const node = { ...createFakeNode(), gain: createAudioParam(1) };
    createdGainNodes.push(node);
    return node;
  });
  // The SoundStyleEngine constructor calls createGain() exactly once (in this order) for
  // masterGain, followed by the 'bgm'/'se'/'ambient' intermediate GainNodes, so swap the
  // first four calls for their own stubs (kept out of createdGainNodes — that array should
  // only track gain nodes created per-voice).
  const categoryGains = {
    bgm: { ...createFakeNode(), gain: createAudioParam(1) },
    se: { ...createFakeNode(), gain: createAudioParam(1) },
    ambient: { ...createFakeNode(), gain: createAudioParam(1) },
  };
  audioContext.createGain.mockImplementationOnce(() => masterGain);
  audioContext.createGain.mockImplementationOnce(() => categoryGains.bgm);
  audioContext.createGain.mockImplementationOnce(() => categoryGains.se);
  audioContext.createGain.mockImplementationOnce(() => categoryGains.ambient);

  return {
    audioContext: audioContext as unknown as AudioContext,
    createdBufferSources,
    createdGainNodes,
    categoryGains,
  };
}

const style: SoundStyleSpecification = {
  version: 1,
  sources: {
    'poi-sfx': {
      type: 'audio-sprite',
      url: '/audio/poi-sfx.mp3',
      sprite: { select: { start: 0, end: 0.4 } },
    },
    'traffic-noise': {
      type: 'single',
      url: '/audio/traffic-loop.mp3',
      loop: true,
    },
    'area-bgm': {
      type: 'audio-sprite',
      url: '/audio/area-bgm.mp3',
      sprite: {
        downtown: { start: 0, end: 0.5, loop: true },
        harbor: { start: 0.5, end: 1, loop: true },
      },
    },
  },
  'sound-layers': [
    {
      id: 'poi-click-sfx',
      type: 'event',
      source: 'poi-sfx',
      'sound-clip': 'select',
      layout: { 'sound-trigger': 'click' },
      paint: { 'sound-volume': 0.5, 'sound-pan': -0.3 },
    },
    {
      id: 'traffic-ambient',
      type: 'ambient',
      source: 'traffic-noise',
      paint: {
        'sound-volume': ['interpolate', ['linear'], ['zoom'], 0, 0, 20, 1],
      },
    },
    {
      id: 'area-bgm-switch',
      type: 'bgm-state',
      source: 'area-bgm',
      layout: { 'sound-state-property': 'area-id' },
      paint: {
        'sound-volume': 0.6,
        'sound-fade-duration': 100,
        'sound-lowpass': ['match', ['get', 'lightPreset'], 'night', 800, 5000],
      },
    },
  ],
};

/**
 * A minimal HTMLAudioElement fake so these tests can run without jsdom (environment: 'node').
 * Plays the same role as the FakeAudio in asset-manager.test.ts (duplication accepted —
 * we want to verify the same mechanism in both places).
 */
class FakeAudio {
  crossOrigin = '';
  loop = false;
  preload = '';
  src = '';
  duration = 5;
  currentTime = 0;
  playbackRate = 1;
  error: unknown = null;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  load(): void {
    queueMicrotask(() => this.dispatch('canplaythrough'));
  }

  play(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {}
  removeAttribute(): void {}

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

describe('SoundStyleEngine', () => {
  let audioContext: AudioContext;
  let createdBufferSources: ReturnType<typeof createFakeAudioContext>['createdBufferSources'];
  let createdGainNodes: ReturnType<typeof createFakeAudioContext>['createdGainNodes'];
  let categoryGains: ReturnType<typeof createFakeAudioContext>['categoryGains'];

  beforeEach(() => {
    const fake = createFakeAudioContext();
    audioContext = fake.audioContext;
    createdBufferSources = fake.createdBufferSources;
    createdGainNodes = fake.createdGainNodes;
    categoryGains = fake.categoryGains;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a style and emits a load event', async () => {
    const engine = new SoundStyleEngine({ audioContext });
    const events: SoundStyleEngineEvent[] = [];
    engine.on('load', (e) => events.push(e));

    await engine.load(style);

    expect(events).toEqual([{ type: 'load' }]);
    expect(engine.getLayer('poi-click-sfx')).toBeDefined();
  });

  // Regression test: a source with streaming: true and no explicit load-strategy must already
  // be loaded by the time load() completes (when the default was 'lazy', no preload trigger
  // was implemented anywhere, causing a regression where BGM went permanently silent).
  it('preloads a streaming source with no explicit load-strategy, so bgm-state plays immediately', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const engine = new SoundStyleEngine({ audioContext });
    const errors: Error[] = [];
    engine.on('error', (e) => {
      if (e.type === 'error') errors.push(e.error);
    });

    const streamingStyle: SoundStyleSpecification = {
      version: 1,
      sources: {
        bgm: { type: 'single', url: '/audio/bgm.mp3', loop: true, streaming: true },
      },
      'sound-layers': [
        {
          id: 'bgm-layer',
          type: 'bgm-state',
          source: 'bgm',
          layout: { 'sound-state-property': 'unused' },
        },
      ],
    };

    await engine.load(streamingStyle);
    engine.setActiveState('bgm-layer', 'active');

    expect(errors).toEqual([]);
    expect(audioContext.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  // Regression test: when a bgm-state layer leaves a state (e.g. a given terrain, dropping the
  // voice's reference count back to 0) and later returns to that same state, a streaming source
  // must be able to play again without reloading (previously the HTMLAudioElement was destroyed
  // the moment refCount hit 0, causing a regression where revisiting the state went silent with
  // a "source not loaded" error).
  it('replays a streaming bgm-state source after leaving and returning to its state', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const engine = new SoundStyleEngine({ audioContext });
    const errors: Error[] = [];
    engine.on('error', (e) => {
      if (e.type === 'error') errors.push(e.error);
    });

    const streamingStyle: SoundStyleSpecification = {
      version: 1,
      sources: {
        bgm: { type: 'single', url: '/audio/bgm.mp3', loop: true, streaming: true },
      },
      'sound-layers': [
        {
          id: 'bgm-layer',
          type: 'bgm-state',
          source: 'bgm',
          layout: { 'sound-state-property': 'unused' },
          paint: { 'sound-fade-duration': 0 },
        },
      ],
    };

    await engine.load(streamingStyle);
    engine.setActiveState('bgm-layer', 'active'); // e.g. entering 'urban'
    engine.setActiveState('bgm-layer', undefined); // leaving 'urban' for another terrain
    engine.setActiveState('bgm-layer', 'active'); // back to 'urban' again

    expect(errors).toEqual([]);
    expect(audioContext.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  // Regression test: if a streaming bgm-state layer is silenced (a fade-out scheduled) and then
  // reactivated to the same state before that fade completes, the stale pause() that was
  // scheduled earlier must not fire later and incorrectly silence the new voice (all voices for
  // the same source share one HTMLAudioElement). Found on-device in a case where terrain
  // detection briefly flickered to a different value during a zoom and immediately snapped back.
  it('does not let a stale scheduled pause silence a streaming voice reactivated before the fade completes', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('Audio', FakeAudio);
      const engine = new SoundStyleEngine({ audioContext });
      const errors: Error[] = [];
      engine.on('error', (e) => {
        if (e.type === 'error') errors.push(e.error);
      });

      const streamingStyle: SoundStyleSpecification = {
        version: 1,
        sources: {
          bgm: { type: 'single', url: '/audio/bgm.mp3', loop: true, streaming: true },
        },
        'sound-layers': [
          {
            id: 'bgm-layer',
            type: 'bgm-state',
            source: 'bgm',
            layout: { 'sound-state-property': 'unused' },
            paint: { 'sound-fade-duration': 2000 },
          },
        ],
      };

      await engine.load(streamingStyle);
      engine.setActiveState('bgm-layer', 'active');
      const pauseSpy = vi.fn();
      // FakeAudio.pause() can't be tracked directly, so swap the pause of the actual in-use
      // element for a spy.
      const handle = (engine as unknown as { assets: { getStreamingHandle: (id: string) => { element: HTMLAudioElement } } }).assets.getStreamingHandle('bgm');
      handle!.element.pause = pauseSpy;

      // Reproduce terrain detection flickering silent and then, before the fade (2000ms)
      // completes, returning to the original state.
      engine.setActiveState('bgm-layer', undefined);
      await vi.advanceTimersByTimeAsync(500);
      engine.setActiveState('bgm-layer', 'active');
      // Even past the time the stale schedule was supposed to fire, pause() should not have
      // been called.
      await vi.advanceTimersByTimeAsync(2000);

      expect(errors).toEqual([]);
      expect(pauseSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds an audio graph and plays on trigger()', async () => {
    const engine = new SoundStyleEngine({ audioContext });
    const playEvents: string[] = [];
    engine.on('layer:play', (e) => {
      if (e.type === 'layer:play') playEvents.push(e.layerId);
    });

    await engine.load(style);
    engine.trigger('poi-click-sfx');

    expect(playEvents).toEqual(['poi-click-sfx']);
    expect(createdBufferSources).toHaveLength(1);
    const sourceNode = createdBufferSources[0];
    if (!sourceNode) throw new Error('expected a buffer source node to be created');
    expect(sourceNode.start).toHaveBeenCalledWith(0, 0, 0.4);
    expect(sourceNode.loop).toBe(false);
  });

  it('emits a layer:stop event once playback ends', async () => {
    const engine = new SoundStyleEngine({ audioContext });
    const stopEvents: string[] = [];
    engine.on('layer:stop', (e) => {
      if (e.type === 'layer:stop') stopEvents.push(e.layerId);
    });

    await engine.load(style);
    engine.trigger('poi-click-sfx');
    const sourceNode = createdBufferSources[0];
    if (!sourceNode) throw new Error('expected a buffer source node to be created');
    sourceNode.onended?.();

    expect(stopEvents).toEqual(['poi-click-sfx']);
  });

  describe('stop()', () => {
    it('stops a currently-playing event voice early and emits layer:stop', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const stopEvents: string[] = [];
      engine.on('layer:stop', (e) => {
        if (e.type === 'layer:stop') stopEvents.push(e.layerId);
      });

      await engine.load(style);
      engine.trigger('poi-click-sfx');
      const sourceNode = createdBufferSources[0];
      if (!sourceNode) throw new Error('expected a buffer source node to be created');

      engine.stop('poi-click-sfx');

      expect(sourceNode.stop).toHaveBeenCalled();
      expect(sourceNode.disconnect).toHaveBeenCalled();
      expect(stopEvents).toEqual(['poi-click-sfx']);

      // For a voice that has already been stop()'d, a later onended (if it fires at all) must
      // not emit layer:stop a second time.
      sourceNode.onended?.();
      expect(stopEvents).toEqual(['poi-click-sfx']);
    });

    it('stops a currently-playing ambient voice and emits layer:stop', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const stopEvents: string[] = [];
      engine.on('layer:stop', (e) => {
        if (e.type === 'layer:stop') stopEvents.push(e.layerId);
      });

      await engine.load(style);
      engine.updateContext('traffic-ambient', { zoom: 20 });
      const sourceNode = createdBufferSources[0];
      if (!sourceNode) throw new Error('expected a buffer source node to be created');

      engine.stop('traffic-ambient');

      expect(sourceNode.stop).toHaveBeenCalled();
      expect(stopEvents).toEqual(['traffic-ambient']);
    });

    it('does nothing when the layer is not currently playing', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const stopEvents: string[] = [];
      engine.on('layer:stop', (e) => {
        if (e.type === 'layer:stop') stopEvents.push(e.layerId);
      });

      await engine.load(style);
      engine.stop('poi-click-sfx');
      engine.stop('traffic-ambient');
      engine.stop('area-bgm-switch');

      expect(stopEvents).toEqual([]);
    });
  });

  it('stops previously-active ambient/bgm-state voices when reloaded with a new style (runtime style switch)', async () => {
    const engine = new SoundStyleEngine({ audioContext });

    await engine.load(style);
    engine.updateContext('traffic-ambient', { zoom: 20 });
    engine.setActiveState('area-bgm-switch', 'downtown');
    expect(createdBufferSources).toHaveLength(2);
    const [ambientVoice, bgmVoice] = createdBufferSources;
    if (!ambientVoice || !bgmVoice) throw new Error('expected both voices to be created');

    await engine.load(style);

    // Voices from the previous style are explicitly stopped and disconnected, so they don't
    // keep playing.
    expect(ambientVoice.stop).toHaveBeenCalled();
    expect(ambientVoice.disconnect).toHaveBeenCalled();
    expect(bgmVoice.stop).toHaveBeenCalled();
    expect(bgmVoice.disconnect).toHaveBeenCalled();

    // A re-entrant onended must not fire the stop handling a second time.
    expect(ambientVoice.onended).toBeNull();
    expect(bgmVoice.onended).toBeNull();
  });

  it('emits an error event when triggering an unknown layer', async () => {
    const engine = new SoundStyleEngine({ audioContext });
    const errors: SoundStyleEngineEvent[] = [];
    engine.on('error', (e) => errors.push(e));

    await engine.load(style);
    engine.trigger('does-not-exist');

    expect(errors).toHaveLength(1);
  });

  it('emits an error event when triggering a non-event layer', async () => {
    const engine = new SoundStyleEngine({ audioContext });
    const errors: SoundStyleEngineEvent[] = [];
    engine.on('error', (e) => errors.push(e));

    await engine.load(style);
    engine.trigger('traffic-ambient');

    expect(errors).toHaveLength(1);
  });

  it('disables only the layer whose source failed to load, leaving other layers usable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('poi-sfx')
          ? Promise.resolve({ ok: false, status: 404 })
          : Promise.resolve({
              ok: true,
              status: 200,
              arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
            }),
      ),
    );

    const engine = new SoundStyleEngine({ audioContext });
    const errors: SoundStyleEngineEvent[] = [];
    const playEvents: string[] = [];
    engine.on('error', (e) => errors.push(e));
    engine.on('layer:play', (e) => {
      if (e.type === 'layer:play') playEvents.push(e.layerId);
    });

    // load() itself must not reject even if some source failed to load.
    await expect(engine.load(style)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);

    // A layer using the failed source just emits an error on trigger() instead of crashing.
    engine.trigger('poi-click-sfx');
    expect(errors).toHaveLength(2);
    expect(playEvents).toEqual([]);

    // Other layers using sources that loaded successfully keep working.
    engine.updateContext('traffic-ambient', { zoom: 0 });
    expect(playEvents).toEqual(['traffic-ambient']);
  });

  describe('setLayerEnabled()', () => {
    it('defaults every layer to enabled', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);
      expect(engine.isLayerEnabled('poi-click-sfx')).toBe(true);
    });

    it('makes trigger() a no-op for a disabled event layer, and re-enables it', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const playEvents: string[] = [];
      engine.on('layer:play', (e) => {
        if (e.type === 'layer:play') playEvents.push(e.layerId);
      });
      await engine.load(style);

      engine.setLayerEnabled('poi-click-sfx', false);
      expect(engine.isLayerEnabled('poi-click-sfx')).toBe(false);
      engine.trigger('poi-click-sfx');
      expect(playEvents).toEqual([]);

      engine.setLayerEnabled('poi-click-sfx', true);
      engine.trigger('poi-click-sfx');
      expect(playEvents).toEqual(['poi-click-sfx']);
    });

    it('stops a currently-looping ambient layer and blocks further updateContext() until re-enabled', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const stopEvents: string[] = [];
      engine.on('layer:stop', (e) => {
        if (e.type === 'layer:stop') stopEvents.push(e.layerId);
      });
      await engine.load(style);

      engine.updateContext('traffic-ambient', { zoom: 20 });
      expect(createdBufferSources).toHaveLength(1);

      engine.setLayerEnabled('traffic-ambient', false);
      expect(stopEvents).toEqual(['traffic-ambient']);

      // While disabled, calling updateContext() must not recreate the voice.
      engine.updateContext('traffic-ambient', { zoom: 20 });
      expect(createdBufferSources).toHaveLength(1);

      engine.setLayerEnabled('traffic-ambient', true);
      engine.updateContext('traffic-ambient', { zoom: 20 });
      expect(createdBufferSources).toHaveLength(2);
    });

    it('fades out a currently-active bgm-state layer and blocks further setActiveState() until re-enabled', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.setActiveState('area-bgm-switch', 'downtown');
      expect(audioContext.createBufferSource).toHaveBeenCalledTimes(1);

      engine.setLayerEnabled('area-bgm-switch', false);
      // setActiveState(id, undefined) runs via stop(), silencing the layer.
      expect(audioContext.createBufferSource).toHaveBeenCalledTimes(1);

      // While disabled, setActiveState() to a new state is ignored.
      engine.setActiveState('area-bgm-switch', 'harbor');
      expect(audioContext.createBufferSource).toHaveBeenCalledTimes(1);

      engine.setLayerEnabled('area-bgm-switch', true);
      engine.setActiveState('area-bgm-switch', 'harbor');
      expect(audioContext.createBufferSource).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-category (bgm/se/ambient) volume', () => {
    it('defaults every category to volume 1, independent of each other and of masterVolume', () => {
      const engine = new SoundStyleEngine({ audioContext });

      expect(engine.getCategoryVolume('bgm')).toBe(1);
      expect(engine.getCategoryVolume('se')).toBe(1);
      expect(engine.getCategoryVolume('ambient')).toBe(1);

      engine.setCategoryVolume('se', 0);
      expect(engine.getCategoryVolume('se')).toBe(0);
      expect(engine.getCategoryVolume('bgm')).toBe(1);
      expect(engine.getCategoryVolume('ambient')).toBe(1);
      expect(engine.getMasterVolume()).toBe(1);
    });

    it('routes an event (SE) layer voice through the "se" category gain, not "bgm"/"ambient"', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.trigger('poi-click-sfx');

      const panner = (audioContext.createStereoPanner as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(panner.connect).toHaveBeenCalledWith(categoryGains.se);
      expect(panner.connect).not.toHaveBeenCalledWith(categoryGains.bgm);
      expect(panner.connect).not.toHaveBeenCalledWith(categoryGains.ambient);
    });

    it('routes an ambient layer voice through the "ambient" category gain', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.updateContext('traffic-ambient', { zoom: 10 });

      const panner = (audioContext.createStereoPanner as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(panner.connect).toHaveBeenCalledWith(categoryGains.ambient);
    });

    it('routes a bgm-state layer voice through the "bgm" category gain', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.setActiveState('area-bgm-switch', 'downtown');

      // area-bgm-switch declares sound-lowpass, so its final node before the category gain is the
      // BiquadFilter (not the panner directly — see buildVoice()'s lastNode chaining).
      const filter = (audioContext.createBiquadFilter as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(filter.connect).toHaveBeenCalledWith(categoryGains.bgm);
    });

    it('muting one category leaves the others at their own independent volume', () => {
      const engine = new SoundStyleEngine({ audioContext });

      engine.setCategoryVolume('se', 0);

      expect(categoryGains.se.gain.value).toBe(0);
      expect(categoryGains.bgm.gain.value).toBe(1);
      expect(categoryGains.ambient.gain.value).toBe(1);
    });
  });

  describe('updateContext() (ambient)', () => {
    it('creates a looping voice on first call and updates it in place afterward', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.updateContext('traffic-ambient', { zoom: 0 });

      expect(createdBufferSources).toHaveLength(1);
      const voice = createdBufferSources[0];
      const gainNode = createdGainNodes[0];
      if (!voice || !gainNode) throw new Error('expected an ambient voice to be created');
      expect(voice.loop).toBe(true);
      expect(voice.start).toHaveBeenCalledWith(0, 0, undefined);
      expect(gainNode.gain.value).toBeCloseTo(0);

      engine.updateContext('traffic-ambient', { zoom: 20 });

      // From the second call onward, the voice is not recreated — only its params are updated.
      expect(createdBufferSources).toHaveLength(1);
      expect(gainNode.gain.value).toBeCloseTo(1);
    });

    it('emits an error event when called for a non-ambient layer', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const errors: SoundStyleEngineEvent[] = [];
      engine.on('error', (e) => errors.push(e));

      await engine.load(style);
      engine.updateContext('poi-click-sfx', { zoom: 0 });

      expect(errors).toHaveLength(1);
    });
  });

  describe('setActiveState() (bgm-state)', () => {
    it('starts a voice for the initial state', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const playEvents: string[] = [];
      engine.on('layer:play', (e) => {
        if (e.type === 'layer:play') playEvents.push(e.layerId);
      });

      await engine.load(style);
      engine.setActiveState('area-bgm-switch', 'downtown');

      expect(playEvents).toEqual(['area-bgm-switch']);
      expect(createdBufferSources).toHaveLength(1);
    });

    it('crossfades to a new voice when the active state changes', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.setActiveState('area-bgm-switch', 'downtown');
      const firstVoice = createdBufferSources[0];
      if (!firstVoice) throw new Error('expected a voice for the initial state');

      engine.setActiveState('area-bgm-switch', 'harbor');

      expect(createdBufferSources).toHaveLength(2);
      expect(firstVoice.stop).toHaveBeenCalled();
      const secondVoice = createdBufferSources[1];
      if (!secondVoice) throw new Error('expected a voice for the new state');
      expect(secondVoice.start).toHaveBeenCalled();
    });

    it('does nothing when called with the already-active state', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.setActiveState('area-bgm-switch', 'downtown');
      engine.setActiveState('area-bgm-switch', 'downtown');

      expect(createdBufferSources).toHaveLength(1);
    });

    it('fades out and emits layer:stop when set to undefined', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const stopEvents: string[] = [];
      engine.on('layer:stop', (e) => {
        if (e.type === 'layer:stop') stopEvents.push(e.layerId);
      });

      await engine.load(style);
      engine.setActiveState('area-bgm-switch', 'downtown');
      engine.setActiveState('area-bgm-switch', undefined);

      expect(stopEvents).toEqual(['area-bgm-switch']);
    });

    it('emits an error event when called for a non-bgm-state layer', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const errors: SoundStyleEngineEvent[] = [];
      engine.on('error', (e) => errors.push(e));

      await engine.load(style);
      engine.setActiveState('traffic-ambient', 'downtown');

      expect(errors).toHaveLength(1);
    });
  });

  describe('updateActiveStateParams() (bgm-state)', () => {
    it('updates the lowpass filter of the currently playing voice without restarting it', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      engine.setActiveState('area-bgm-switch', 'downtown', {
        zoom: 0,
        feature: { properties: { lightPreset: 'day' } },
      });
      expect(createdBufferSources).toHaveLength(1);
      const filterNode = (audioContext.createBiquadFilter as unknown as ReturnType<typeof vi.fn>).mock.results[0]
        ?.value as { frequency: { value: number } };
      expect(filterNode.frequency.value).toBe(5000);

      engine.updateActiveStateParams('area-bgm-switch', {
        zoom: 0,
        feature: { properties: { lightPreset: 'night' } },
      });

      // Only the existing voice's filter is updated; no new voice is created (so playback
      // position is not reset).
      expect(createdBufferSources).toHaveLength(1);
      expect(filterNode.frequency.value).toBe(800);
    });

    it('does nothing when there is no currently playing voice', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      await engine.load(style);

      expect(() =>
        engine.updateActiveStateParams('area-bgm-switch', { zoom: 0 }),
      ).not.toThrow();
      expect(createdBufferSources).toHaveLength(0);
    });

    it('emits an error event when called for a non-bgm-state layer', async () => {
      const engine = new SoundStyleEngine({ audioContext });
      const errors: SoundStyleEngineEvent[] = [];
      engine.on('error', (e) => errors.push(e));

      await engine.load(style);
      engine.updateActiveStateParams('traffic-ambient', { zoom: 0 });

      expect(errors).toHaveLength(1);
    });
  });
});
