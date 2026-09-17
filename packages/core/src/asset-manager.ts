import type { AssetLoadStrategy, SingleSoundSource, SoundSourceSpecification } from './types.js';

export interface ClipRange {
  /** Offset (in seconds) passed to AudioBufferSourceNode#start */
  offset: number;
  /** Playback duration (in seconds) */
  duration: number;
  loop: boolean;
}

export type AssetKind = 'buffer' | 'streaming';
export type AssetLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Determines a source's kind, and which load strategy to use when none is given explicitly,
 * purely from the contents of its SoundSourceSpecification (the default is always 'preload' —
 * even for a streaming source, 'preload' doesn't involve decodeAudioData, so it doesn't
 * undermine the "doesn't consume memory" benefit that streaming is meant to provide).
 * Every call site that invokes `AssetManager.register()` should decide its `strategy` argument
 * through this function — reimplementing the same logic at each call site risks drift between
 * implementations, such as one of them overlooking an explicit `load-strategy: 'lazy'`.
 */
export function resolveAssetLoadStrategy(source: SoundSourceSpecification): AssetLoadStrategy {
  if (source.type === 'single' && source.streaming) {
    return source['load-strategy'] ?? 'preload';
  }
  return 'preload';
}

/** Error type that lets fetch failures, decode failures, and streaming load failures be distinguished, each carrying the URL that caused it */
export class AssetLoadError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetLoadError';
  }
}

/** The runtime handle held by a single entry with streaming: true */
export interface StreamingHandle {
  element: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode;
}

interface AssetEntry {
  spec: SoundSourceSpecification;
  kind: AssetKind;
  strategy: AssetLoadStrategy;
  state: AssetLoadState;
  buffer?: AudioBuffer;
  streaming?: StreamingHandle;
  loadPromise?: Promise<void>;
  /** Only used for streaming assets. The HTMLAudioElement is released once this reaches 0. */
  refCount: number;
}

export interface AssetManagerOptions {
  audioContext: AudioContext;
  /**
   * The base URL used to resolve `sources[].url` (always a root-relative path, e.g.
   * '/audio/xxx.mp3'). When omitted, the url is passed straight to `fetch`/`<audio>.src`
   * as-is (resolved by the browser's default document.baseURI). The intended workflow is to
   * omit this in local development and change only this option when moving assets to a CDN
   * in production. When baseUrl has a path component (e.g. jsDelivr's
   * 'https://cdn.jsdelivr.net/gh/user/repo@tag/'), that path is preserved and the url's
   * root-relative path is resolved underneath it (see resolveUrl — naively doing
   * `new URL(url, baseUrl)` would interpret the leading `/` as "an absolute path from the
   * origin" and drop baseUrl's path component entirely, so we transform the input to avoid
   * that).
   */
  baseUrl?: string | URL;
}

/**
 * Manages sound-style's `sources`. Sound effects (audio-sprite, or single without streaming)
 * are fetched and expanded into an AudioBuffer via decodeAudioData and kept resident in
 * memory, while BGM (single with streaming: true) is played back via streaming through an
 * HTMLAudioElement + MediaElementAudioSourceNode (since the browser handles Range requests
 * automatically, AssetManager itself doesn't need to implement any Range handling).
 */
export class AssetManager {
  private readonly audioContext: AudioContext;
  private readonly baseUrl?: string | URL;
  private readonly entries = new Map<string, AssetEntry>();
  /** Cache that avoids duplicate fetch/decode for the same URL (buffer assets only) */
  private readonly bufferCache = new Map<string, Promise<AudioBuffer>>();

  constructor(options: AssetManagerOptions) {
    this.audioContext = options.audioContext;
    this.baseUrl = options.baseUrl;
  }

  /**
   * Registers sources[sourceId]. No actual fetch happens here — regardless of whether
   * strategy is 'preload', loading only begins once the caller explicitly calls
   * `ensureLoaded()`. When `strategy` is omitted it defaults to 'preload' (the caller is
   * expected to determine and pass the strategy from the source's contents — including the
   * 'lazy' default for streaming sources — e.g. engine.load()).
   */
  register(sourceId: string, spec: SoundSourceSpecification, strategy: AssetLoadStrategy = 'preload'): void {
    const kind: AssetKind = spec.type === 'single' && spec.streaming ? 'streaming' : 'buffer';
    this.entries.set(sourceId, { spec, kind, strategy, state: 'idle', refCount: 0 });
  }

  /**
   * An idempotent load entry point. Returns the existing Promise if the source is already
   * loaded or loading. For sources with the lazy strategy, the caller invokes this at the
   * moment the source is actually needed (e.g. an event firing, entering a zone).
   */
  ensureLoaded(sourceId: string): Promise<void> {
    const entry = this.entries.get(sourceId);
    if (!entry) {
      return Promise.reject(new Error(`Unknown asset source: ${sourceId}`));
    }
    if (entry.state === 'loaded') {
      return Promise.resolve();
    }
    if (entry.loadPromise) {
      return entry.loadPromise;
    }

    entry.state = 'loading';
    const load = entry.kind === 'streaming' ? this.loadStreaming(sourceId, entry) : this.loadBuffer(entry);
    const promise = load
      .then(() => {
        entry.state = 'loaded';
      })
      .catch((error: unknown) => {
        entry.state = 'error';
        entry.loadPromise = undefined;
        throw error;
      });
    entry.loadPromise = promise;
    return promise;
  }

  /**
   * Assumes the url is always written as a root-relative path in the Style JSON (e.g.
   * '/audio/xxx.mp3') — see AssetManagerOptions.baseUrl. Returns the url unchanged if baseUrl
   * isn't specified. When it is, the leading `/` is stripped before resolving the url as a
   * path relative to baseUrl — otherwise `new URL()` would treat the leading `/` as "an
   * absolute path from baseUrl's origin" and discard baseUrl's path component (e.g. jsDelivr's
   * '/gh/user/repo@tag/') entirely. If baseUrl has no trailing `/`, its last path segment
   * would be treated as a "file name" and get replaced (per RFC 3986's relative-URL
   * resolution rules), so we append one before passing it to new URL() if it's missing.
   */
  private resolveUrl(url: string): string {
    if (!this.baseUrl) {
      return url;
    }
    const baseString = this.baseUrl.toString();
    const base = baseString.endsWith('/') ? baseString : `${baseString}/`;
    const relative = url.replace(/^\/+/, '');
    return new URL(relative, base).toString();
  }

  private async loadBuffer(entry: AssetEntry): Promise<void> {
    entry.buffer = await this.decodeUrl(this.resolveUrl(entry.spec.url));
  }

  private decodeUrl(url: string): Promise<AudioBuffer> {
    let pending = this.bufferCache.get(url);
    if (!pending) {
      pending = fetch(url)
        .then((response) => {
          if (!response.ok) {
            throw new AssetLoadError(`Failed to fetch audio source "${url}": ${response.status}`, url);
          }
          return response.arrayBuffer();
        })
        .then((arrayBuffer) => this.audioContext.decodeAudioData(arrayBuffer))
        .catch((error: unknown) => {
          this.bufferCache.delete(url);
          throw error instanceof AssetLoadError
            ? error
            : new AssetLoadError(`Failed to decode audio source "${url}"`, url, error);
        });
      this.bufferCache.set(url, pending);
    }
    return pending;
  }

  /**
   * Loads the HTMLAudioElement for a single streaming source. Resolves on 'canplaythrough'
   * (the point at which it looks likely the media can play through to the end without
   * seeking) — since BGM should start playing immediately, we use this stricter condition
   * rather than 'loadedmetadata'. createMediaElementSource can only be called once per
   * element, so we call it exactly once here, on successful load.
   */
  private loadStreaming(sourceId: string, entry: AssetEntry): Promise<void> {
    const spec = entry.spec as SingleSoundSource;
    const url = this.resolveUrl(spec.url);
    const element = new Audio();
    element.crossOrigin = 'anonymous';
    element.loop = spec.loop ?? false;
    element.preload = 'auto';
    // There is a reproducible browser behavior on real devices (discovered 2026-09-12) where
    // only the very first play() call is silent (subsequent calls work fine); it appears to
    // happen when an <audio> element that has never been attached to the DOM is connected to
    // Web Audio via MediaElementAudioSourceNode. We work around this by actually appending the
    // element (kept invisible) to document.body. It's removed again on release
    // (releaseStreamingHandle).
    if (typeof document !== 'undefined') {
      element.style.display = 'none';
      document.body.appendChild(element);
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        element.removeEventListener('canplaythrough', onCanPlay);
        element.removeEventListener('error', onError);
      };
      const onCanPlay = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        element.pause();
        element.removeAttribute('src');
        element.load();
        element.parentNode?.removeChild(element);
        reject(new AssetLoadError(`Failed to load streaming source "${url}"`, url, element.error));
      };
      element.addEventListener('canplaythrough', onCanPlay, { once: true });
      element.addEventListener('error', onError, { once: true });
      element.src = url;
      element.load();
    }).then(() => {
      const sourceNode = this.audioContext.createMediaElementSource(element);
      const handle: StreamingHandle = { element, sourceNode };
      // If a clear()/unload() ran while this load was in flight (e.g. a style switch racing a
      // still-loading BGM), `entry` was already dropped from `this.entries` and replaced or
      // removed — assigning to it here would leave this <audio> element permanently attached to
      // document.body with nothing left to release it. Release it ourselves instead of leaking it.
      if (this.entries.get(sourceId) !== entry) {
        this.releaseStreamingHandle(handle);
        return;
      }
      entry.streaming = handle;
    });
  }

  /** Valid only for sources where kind === 'buffer'. undefined if not yet loaded. */
  getBuffer(sourceId: string): AudioBuffer | undefined {
    return this.entries.get(sourceId)?.buffer;
  }

  /** Valid only for sources where kind === 'streaming'. undefined if not yet loaded. */
  getStreamingHandle(sourceId: string): StreamingHandle | undefined {
    return this.entries.get(sourceId)?.streaming;
  }

  getKind(sourceId: string): AssetKind | undefined {
    return this.entries.get(sourceId)?.kind;
  }

  /**
   * For an audio-sprite source, resolves offset/duration from the clip name. For a single
   * source, clipName is omitted and the range of the entire source is returned (streaming
   * sources use element.duration).
   */
  getClipRange(sourceId: string, clipName?: string): ClipRange | undefined {
    const entry = this.entries.get(sourceId);
    if (!entry) {
      return undefined;
    }
    const { spec } = entry;
    if (spec.type === 'single') {
      const duration = entry.kind === 'streaming' ? entry.streaming?.element.duration : entry.buffer?.duration;
      if (duration === undefined || Number.isNaN(duration)) {
        return undefined;
      }
      return { offset: 0, duration, loop: spec.loop ?? false };
    }
    if (!entry.buffer || !clipName) {
      return undefined;
    }
    const clip = spec.sprite[clipName];
    if (!clip) {
      return undefined;
    }
    return { offset: clip.start, duration: clip.end - clip.start, loop: clip.loop ?? false };
  }

  getLoadState(sourceId: string): AssetLoadState {
    return this.entries.get(sourceId)?.state ?? 'idle';
  }

  /**
   * Call this when a voice is created. Increments the reference count for streaming assets
   * (buffers are assumed to stay resident, so this has no effect on them). Usage patterns
   * like bgm-state, which repeatedly acquire and release the same source, routinely bring
   * this back down to 0, so the HTMLAudioElement is not destroyed just because refCount
   * reaches 0 (see release()) — this count itself is kept around as room for a possible
   * future feature that explicitly releases only sources that will truly never be used
   * again.
   */
  acquire(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (entry) {
      entry.refCount += 1;
    }
  }

  /**
   * Call this when a voice is destroyed. Only decrements the reference count; it never
   * destroys the HTMLAudioElement. A bgm-state-style layer repeatedly acquires and releases
   * voices against the same streaming source (stopping and, if the same terrain is
   * re-entered, resuming playback, over and over), so destroying the HTMLAudioElement the
   * moment its voice count drops to zero would leave no way to reload it the next time that
   * source is needed (AssetManager itself is not designed to know "when" to load something),
   * causing a regression where it goes permanently silent. Like buffer assets, streaming
   * assets are kept resident until a Style switch (clear()) or the engine's own disposal
   * (dispose()).
   */
  release(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.kind !== 'streaming') {
      return;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
  }

  private releaseStreamingHandle(handle: StreamingHandle): void {
    handle.sourceNode.disconnect();
    handle.element.pause();
    handle.element.removeAttribute('src');
    handle.element.load();
    handle.element.parentNode?.removeChild(handle.element);
  }

  unload(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (entry?.kind === 'streaming' && entry.streaming) {
      this.releaseStreamingHandle(entry.streaming);
    }
    this.entries.delete(sourceId);
  }

  /**
   * Used on a runtime Style switch. The fetch-result URL cache (bufferCache) is left intact
   * — so that a source with the same URL reused across the old and new styles doesn't need
   * to be re-fetched or re-decoded. Streaming assets aren't covered by the URL cache, so they
   * are reliably released here.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === 'streaming' && entry.streaming) {
        this.releaseStreamingHandle(entry.streaming);
      }
    }
    this.entries.clear();
  }

  dispose(): void {
    this.clear();
    this.bufferCache.clear();
  }
}
