import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetManager, resolveAssetLoadStrategy } from './asset-manager.js';
import type { AudioSpriteSoundSource, SingleSoundSource } from './types.js';

// Regression test: this assumes every call site that invokes register() decides its
// strategy through this function — we centralized it after finding drift where one call
// site's implementation had overlooked load-strategy: 'lazy'.
describe('resolveAssetLoadStrategy', () => {
  it('defaults every source kind to preload', () => {
    expect(resolveAssetLoadStrategy({ type: 'single', url: '/a.mp3' })).toBe('preload');
    expect(resolveAssetLoadStrategy({ type: 'audio-sprite', url: '/a.mp3', sprite: {} })).toBe('preload');
    expect(resolveAssetLoadStrategy({ type: 'single', url: '/a.mp3', streaming: true })).toBe('preload');
  });

  it('respects an explicit load-strategy only for streaming sources', () => {
    expect(
      resolveAssetLoadStrategy({ type: 'single', url: '/a.mp3', streaming: true, 'load-strategy': 'lazy' }),
    ).toBe('lazy');
  });
});

function fakeAudioBuffer(duration: number): AudioBuffer {
  return { duration } as AudioBuffer;
}

function fakeAudioContext(decodedDuration = 10): {
  audioContext: AudioContext;
  decodeAudioData: ReturnType<typeof vi.fn>;
  createMediaElementSource: ReturnType<typeof vi.fn>;
} {
  const decodeAudioData = vi.fn().mockResolvedValue(fakeAudioBuffer(decodedDuration));
  const createMediaElementSource = vi.fn().mockImplementation(() => ({
    disconnect: vi.fn(),
  }));
  const audioContext = { decodeAudioData, createMediaElementSource } as unknown as AudioContext;
  return { audioContext, decodeAudioData, createMediaElementSource };
}

/** A minimal HTMLAudioElement fake so tests also run without jsdom (environment: 'node') */
class FakeAudio {
  crossOrigin = '';
  loop = false;
  preload = '';
  src = '';
  duration = 5;
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
    if (this.src === 'bad.mp3') {
      queueMicrotask(() => this.dispatch('error'));
    } else {
      queueMicrotask(() => this.dispatch('canplaythrough'));
    }
  }

  pause(): void {}
  removeAttribute(): void {}

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

describe('AssetManager (buffer sources)', () => {
  beforeEach(() => {
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

  it('loads a single source and exposes its full-buffer clip range', async () => {
    const { audioContext } = fakeAudioContext(12.5);
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/loop.mp3', loop: true };

    manager.register('traffic', source);
    expect(manager.getLoadState('traffic')).toBe('idle');
    expect(manager.getKind('traffic')).toBe('buffer');

    await manager.ensureLoaded('traffic');

    expect(manager.getLoadState('traffic')).toBe('loaded');
    expect(manager.getBuffer('traffic')).toBeDefined();
    expect(manager.getClipRange('traffic')).toEqual({ offset: 0, duration: 12.5, loop: true });
  });

  it('resolves audio-sprite clip ranges by name', async () => {
    const { audioContext } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: AudioSpriteSoundSource = {
      type: 'audio-sprite',
      url: '/audio/poi-sfx.mp3',
      sprite: {
        select: { start: 0, end: 0.4 },
        deselect: { start: 0.4, end: 0.7, loop: false },
      },
    };

    manager.register('poi-sfx', source);
    await manager.ensureLoaded('poi-sfx');

    expect(manager.getClipRange('poi-sfx', 'select')).toEqual({
      offset: 0,
      duration: 0.4,
      loop: false,
    });
    expect(manager.getClipRange('poi-sfx', 'missing-clip')).toBeUndefined();
  });

  it('dedupes decoding for sources that share the same URL', async () => {
    const { audioContext, decodeAudioData } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/shared.mp3' };

    manager.register('a', source);
    manager.register('b', { ...source });
    await Promise.all([manager.ensureLoaded('a'), manager.ensureLoaded('b')]);

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('marks a source as errored when fetching fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { audioContext } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/missing.mp3' };

    manager.register('missing', source);
    await expect(manager.ensureLoaded('missing')).rejects.toThrow();
    expect(manager.getLoadState('missing')).toBe('error');
    expect(manager.getBuffer('missing')).toBeUndefined();
  });

  it('resolves a root-relative url under baseUrl, preserving baseUrl\'s own path', async () => {
    const { audioContext } = fakeAudioContext();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new AssetManager({ audioContext, baseUrl: 'https://cdn.example.com/assets/' });
    const source: SingleSoundSource = { type: 'single', url: '/audio/loop.mp3' };

    manager.register('traffic', source);
    await manager.ensureLoaded('traffic');

    // '/assets/' must survive the resolution — a naive `new URL(url, baseUrl)` would treat the
    // leading '/' in `url` as absolute-from-origin and silently drop it (see resolveUrl's comment).
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/assets/audio/loop.mp3');
  });

  it('resolves against a multi-segment baseUrl like a jsDelivr GitHub-tag CDN URL', async () => {
    const { audioContext } = fakeAudioContext();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new AssetManager({
      audioContext,
      baseUrl: 'https://cdn.jsdelivr.net/gh/akiramur/sound-style-assets@v1.0.0/',
    });
    const source: SingleSoundSource = { type: 'single', url: '/audio/poi-sfx.wav' };

    manager.register('poi-sfx', source);
    await manager.ensureLoaded('poi-sfx');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/gh/akiramur/sound-style-assets@v1.0.0/audio/poi-sfx.wav',
    );
  });

  it('tolerates a baseUrl missing its trailing slash', async () => {
    const { audioContext } = fakeAudioContext();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new AssetManager({
      audioContext,
      baseUrl: 'https://cdn.jsdelivr.net/gh/akiramur/sound-style-assets@v1.0.0',
    });
    const source: SingleSoundSource = { type: 'single', url: '/audio/poi-sfx.wav' };

    manager.register('poi-sfx', source);
    await manager.ensureLoaded('poi-sfx');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/gh/akiramur/sound-style-assets@v1.0.0/audio/poi-sfx.wav',
    );
  });

  it('does not fetch a lazy-strategy source until ensureLoaded is called', async () => {
    const { audioContext } = fakeAudioContext();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/lazy.mp3' };

    manager.register('lazy', source, 'lazy');
    expect(manager.getLoadState('lazy')).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();

    await manager.ensureLoaded('lazy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AssetManager (streaming sources)', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a streaming source without decoding it and exposes a MediaElementAudioSourceNode', async () => {
    const { audioContext, decodeAudioData, createMediaElementSource } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/bgm.mp3', streaming: true, loop: true };

    manager.register('bgm', source, 'lazy');
    expect(manager.getKind('bgm')).toBe('streaming');

    await manager.ensureLoaded('bgm');

    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(manager.getStreamingHandle('bgm')).toBeDefined();
    expect(manager.getClipRange('bgm')).toEqual({ offset: 0, duration: 5, loop: true });
  });

  it('rejects when the streaming element fails to load', async () => {
    const { audioContext } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: 'bad.mp3', streaming: true };

    manager.register('bgm', source);
    await expect(manager.ensureLoaded('bgm')).rejects.toThrow();
    expect(manager.getLoadState('bgm')).toBe('error');
  });

  // We used to destroy the HTMLAudioElement as soon as refCount dropped back to 0, but a
  // bgm-state-style layer repeatedly acquires and releases voices against the same streaming
  // source (stopping and, on revisiting the same terrain, resuming playback, over and over),
  // which caused a regression: there was no way to reload the source the next time it was
  // needed, so it went permanently silent. Like buffer assets, streaming assets now stay
  // resident until a Style switch (clear()).
  it('keeps the HTMLAudioElement resident even after the refcount drops to zero', async () => {
    const { audioContext } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/bgm.mp3', streaming: true };

    manager.register('bgm', source);
    await manager.ensureLoaded('bgm');
    manager.acquire('bgm');
    manager.release('bgm');

    expect(manager.getStreamingHandle('bgm')).toBeDefined();
    expect(manager.getLoadState('bgm')).toBe('loaded');
  });

  it('releases the HTMLAudioElement on clear()', async () => {
    const { audioContext } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/bgm.mp3', streaming: true };

    manager.register('bgm', source);
    await manager.ensureLoaded('bgm');
    manager.clear();

    expect(manager.getStreamingHandle('bgm')).toBeUndefined();
    expect(manager.getLoadState('bgm')).toBe('idle');
  });

  // Regression test: unload() used to just drop the entry from the Map without releasing its
  // streaming handle, unlike clear() — leaking the <audio> element and its
  // MediaElementAudioSourceNode whenever unload() was called on a streaming source.
  it('releases the HTMLAudioElement on unload()', async () => {
    const { audioContext, createMediaElementSource } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/bgm.mp3', streaming: true };

    manager.register('bgm', source);
    await manager.ensureLoaded('bgm');
    const sourceNode = createMediaElementSource.mock.results[0]?.value as { disconnect: ReturnType<typeof vi.fn> };

    manager.unload('bgm');

    expect(manager.getStreamingHandle('bgm')).toBeUndefined();
    expect(sourceNode.disconnect).toHaveBeenCalled();
  });

  // Regression test: a streaming load resolving (canplaythrough) after a clear()/unload() already
  // ran while it was still in flight (e.g. a style switch racing a still-loading BGM) used to
  // assign the loaded handle onto an entry object that was no longer reachable from `entries`,
  // permanently leaking the <audio> element (it was never appended to a map that anything would
  // later release). The fix detects this staleness and releases the orphaned element instead.
  it('releases an orphaned <audio> element when clear() races an in-flight streaming load', async () => {
    class ManualFakeAudio {
      crossOrigin = '';
      loop = false;
      preload = '';
      src = '';
      duration = 5;
      error: unknown = null;
      pause = vi.fn();
      removeAttribute = vi.fn();
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
        // Deliberately does not auto-fire — the test triggers canplaythrough manually so it can
        // run clear() in between register() and the load settling.
      }

      fireCanPlayThrough(): void {
        for (const listener of [...(this.listeners.get('canplaythrough') ?? [])]) {
          listener();
        }
      }
    }

    const instances: ManualFakeAudio[] = [];
    vi.stubGlobal(
      'Audio',
      class extends ManualFakeAudio {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );

    const { audioContext, createMediaElementSource } = fakeAudioContext();
    const manager = new AssetManager({ audioContext });
    const source: SingleSoundSource = { type: 'single', url: '/audio/bgm.mp3', streaming: true };

    manager.register('bgm', source);
    const loadPromise = manager.ensureLoaded('bgm');

    // A style switch (or unload()) races the still-in-flight load.
    manager.clear();

    // The in-flight load now settles, after its entry has already been dropped.
    instances[0]?.fireCanPlayThrough();
    await loadPromise;

    expect(manager.getStreamingHandle('bgm')).toBeUndefined();
    const sourceNode = createMediaElementSource.mock.results[0]?.value as { disconnect: ReturnType<typeof vi.fn> };
    expect(sourceNode.disconnect).toHaveBeenCalled();
    expect(instances[0]?.pause).toHaveBeenCalled();
  });
});
