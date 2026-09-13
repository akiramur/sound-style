import { AssetManager, resolveAssetLoadStrategy, type ClipRange, type StreamingHandle } from './asset-manager.js';
import {
  ExpressionEvaluator,
  type CompiledPropertyExpression,
  type EvaluationContext,
  type PropertyValueSpec,
} from './expression-evaluator.js';
import { validateSoundStyle } from './validate.js';
import type {
  AmbientSoundLayer,
  BgmPriorityGroup,
  BgmStateSoundLayer,
  EventSoundLayer,
  ProximityTriggerGroup,
  SoundLayerSpecification,
  SoundStyleSpecification,
} from './types.js';

/** Optional metadata a trigger() caller can attach to explain "why it played". Passed through as-is on layer:play/layer:stop. */
export interface TriggerMeta {
  /** e.g. 'proximity' (originating from proximity-trigger-groups). Undefined when omitted (a normal firing such as a click). */
  source?: string;
}

export type SoundStyleEngineEvent =
  | { type: 'load' }
  | { type: 'error'; error: Error; layerId?: string }
  | { type: 'layer:play'; layerId: string; feature?: EvaluationContext['feature']; meta?: TriggerMeta }
  | { type: 'layer:stop'; layerId: string; feature?: EvaluationContext['feature']; meta?: TriggerMeta };

export interface SoundStyleEngineOptions {
  audioContext?: AudioContext;
  /**
   * The base URL used when resolving sources[].url. When omitted, the `url` in the Style JSON
   * is used as-is (intended for root-relative paths during local development). The idea is that
   * when assets move to a CDN, only this option needs to change — the Style JSON itself
   * shouldn't need to be touched.
   */
  baseUrl?: string | URL;
}

/**
 * The three sound-layer types, exposed as an app-facing mixing category (so apps can mute/adjust
 * "all BGM" or "all SE" independently of masterVolume) — 'bgm-state' -> 'bgm', 'event' -> 'se',
 * 'ambient' -> 'ambient'. Renamed here rather than reusing SoundLayerSpecification['type']
 * verbatim since "event" reads oddly as a volume-mixing concept from an app's perspective.
 */
export type SoundCategory = 'bgm' | 'se' | 'ambient';

type PaintPropertyName =
  | 'sound-volume'
  | 'sound-pitch'
  | 'sound-pan'
  | 'sound-lowpass'
  | 'sound-fade-duration';

const PAINT_PROPERTY_SPECS: Record<PaintPropertyName, PropertyValueSpec> = {
  'sound-volume': { type: 'number', default: 1, minimum: 0, maximum: 1 },
  'sound-pitch': { type: 'number', default: 1, minimum: 0.01 },
  'sound-pan': { type: 'number', default: 0, minimum: -1, maximum: 1 },
  'sound-lowpass': { type: 'number', default: 22050, minimum: 10 },
  'sound-fade-duration': { type: 'number', default: 300, minimum: 0 },
};

interface LayerRuntime {
  spec: SoundLayerSpecification;
  compiledPaint: Partial<Record<PaintPropertyName, CompiledPropertyExpression<number>>>;
}

/**
 * A discriminated union that lets AudioBufferSourceNode (SE / already-decoded via decodeAudioData)
 * and MediaElementAudioSourceNode (BGM / streaming: true) be treated uniformly as a voice's actual
 * playback node. Both are AudioNodes, so `.connect()` can be called the same way regardless of
 * kind (see buildVoice below).
 */
type PlaybackHandle =
  | { kind: 'buffer'; sourceNode: AudioBufferSourceNode }
  | { kind: 'streaming'; sourceId: string; element: HTMLAudioElement; sourceNode: MediaElementAudioSourceNode };

interface Voice {
  playback: PlaybackHandle;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
  filterNode?: BiquadFilterNode;
}

/** resolveAsset()'s return value. For streaming, the handle held by AssetManager is passed through as-is. */
type ResolvedAsset =
  | { kind: 'buffer'; buffer: AudioBuffer }
  | { kind: 'streaming'; handle: StreamingHandle };

interface BgmVoice extends Voice {
  stateKey: string;
}

type EventHandler = (event: SoundStyleEngineEvent) => void;

const DEFAULT_EVALUATION_CONTEXT: EvaluationContext = { zoom: 0 };

export class SoundStyleEngine {
  private readonly audioContext: AudioContext;
  private readonly assets: AssetManager;
  private readonly evaluator: ExpressionEvaluator;
  private readonly masterGain: GainNode;
  /** The intermediate GainNode for each of 'bgm'/'se'/'ambient' (between masterGain and voices). Operated on by setCategoryVolume(). */
  private readonly categoryGains: Record<SoundCategory, GainNode>;
  private readonly layers = new Map<string, LayerRuntime>();
  private readonly listeners = new Map<SoundStyleEngineEvent['type'], Set<EventHandler>>();
  /** ambient type: the voice that keeps playing continuously per layer (only its parameters get updated each time paint is re-evaluated) */
  private readonly ambientVoices = new Map<string, Voice>();
  /**
   * event type: records the voice most recently created by trigger(), keyed by layer ID (so
   * stop() can end it early — e.g. preview playback in an editing UI). Consecutive trigger()
   * calls on the same layer (e.g. actual rapid clicking) simply overwrite this Map entry; the
   * older voice itself keeps playing until onended (this preserves normal trigger() behavior,
   * which allows multiple overlapping sound effects).
   */
  private readonly activeEventVoices = new Map<string, Voice>();
  /** bgm-state type: the voice for the currently active state per layer (crossfaded on switch) */
  private readonly bgmVoices = new Map<string, BgmVoice>();
  /** The loaded Style's 'bgm-priority-groups' (read via getBgmPriorityGroups(), e.g. by MapboxSoundAdapter) */
  private bgmPriorityGroups: BgmPriorityGroup[] = [];
  /** The loaded Style's 'proximity-trigger-groups' (read via getProximityTriggerGroups(), e.g. by MapboxSoundAdapter) */
  private proximityTriggerGroups: ProximityTriggerGroup[] = [];
  /** The loaded Style's sources[].attribution values, deduplicated (see getAttributions()) */
  private attributions: string[] = [];
  /** Tracks pending stops (setTimeout) per streaming source's sourceId. See scheduleStop(). */
  private readonly pendingStreamingStops = new Map<string, { timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  /**
   * Layer IDs disabled via setLayerEnabled(id, false) (e.g. an app's individual POI/traffic
   * toggles). trigger()/updateContext()/setActiveState()/updateActiveStateParams() do nothing
   * (early return) for any layerId contained here. The target-layer/filter on the Style side
   * itself is left unchanged — this only temporarily overrides, on the app side, whether this
   * layer should play at all.
   */
  private readonly disabledLayers = new Set<string>();

  constructor(options: SoundStyleEngineOptions = {}) {
    this.audioContext = options.audioContext ?? new AudioContext();
    this.assets = new AssetManager({ audioContext: this.audioContext, baseUrl: options.baseUrl });
    this.evaluator = new ExpressionEvaluator({ propertySpecs: PAINT_PROPERTY_SPECS });
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);

    const categories: SoundCategory[] = ['bgm', 'se', 'ambient'];
    this.categoryGains = Object.fromEntries(
      categories.map((category) => {
        const gain = this.audioContext.createGain();
        gain.connect(this.masterGain);
        return [category, gain];
      }),
    ) as Record<SoundCategory, GainNode>;
  }

  /**
   * Loads a style document, fetching/decoding its sources and initializing its layers.
   * If a style is already loaded (a runtime style switch), all voices playing under the
   * previous style are stopped and disconnected first, then swapped for the new layers/sources
   * (analogous to Mapbox GL JS's setStyle()).
   */
  async load(style: SoundStyleSpecification): Promise<void> {
    const validated = validateSoundStyle(style);
    this.stopAllVoices();
    this.layers.clear();
    this.clearPendingStreamingStops();
    this.assets.clear();

    const preloadIds: string[] = [];
    const attributions = new Set<string>();
    for (const [sourceId, source] of Object.entries(validated.sources)) {
      const strategy = resolveAssetLoadStrategy(source);
      this.assets.register(sourceId, source, strategy);
      if (strategy === 'preload') {
        preloadIds.push(sourceId);
      }
      if (source.attribution) {
        attributions.add(source.attribution);
      }
    }
    this.attributions = Array.from(attributions);

    await Promise.all(
      preloadIds.map((sourceId) =>
        this.assets.ensureLoaded(sourceId).catch((error: unknown) => {
          this.emit({
            type: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }),
      ),
    );

    for (const layerSpec of validated['sound-layers']) {
      this.layers.set(layerSpec.id, {
        spec: layerSpec,
        compiledPaint: this.compilePaint(layerSpec),
      });
    }
    this.bgmPriorityGroups = validated['bgm-priority-groups'] ?? [];
    this.proximityTriggerGroups = validated['proximity-trigger-groups'] ?? [];

    this.emit({ type: 'load' });
  }

  private compilePaint(layerSpec: SoundLayerSpecification): LayerRuntime['compiledPaint'] {
    const paint = layerSpec.paint ?? {};
    const compiled: LayerRuntime['compiledPaint'] = {
      'sound-volume': this.evaluator.createPropertyExpression('sound-volume', paint['sound-volume']),
      'sound-pitch': this.evaluator.createPropertyExpression('sound-pitch', paint['sound-pitch']),
      'sound-pan': this.evaluator.createPropertyExpression('sound-pan', paint['sound-pan']),
      'sound-fade-duration': this.evaluator.createPropertyExpression(
        'sound-fade-duration',
        paint['sound-fade-duration'],
      ),
    };
    // sound-lowpass means "filter disabled if unspecified", which has different semantics from
    // falling back to spec.default, so it is only compiled when explicitly specified.
    if (paint['sound-lowpass'] !== undefined) {
      compiled['sound-lowpass'] = this.evaluator.createPropertyExpression(
        'sound-lowpass',
        paint['sound-lowpass'],
      );
    }
    return compiled;
  }

  getMasterVolume(): number {
    return this.masterGain.gain.value;
  }

  setMasterVolume(volume: number): void {
    this.masterGain.gain.value = volume;
  }

  /** The intermediate volume for each of 'bgm'/'se'/'ambient' (independent of masterVolume; 0 mutes completely). Default 1. */
  getCategoryVolume(category: SoundCategory): number {
    return this.categoryGains[category].gain.value;
  }

  setCategoryVolume(category: SoundCategory, volume: number): void {
    this.categoryGains[category].gain.value = volume;
  }

  getLayer(layerId: string): SoundLayerSpecification | undefined {
    return this.layers.get(layerId)?.spec;
  }

  /**
   * Per-layer ON/OFF toggling (e.g. an app's individual POI/traffic toggles, or a group UI that
   * mutes several layers at once). Once disabled, all subsequent trigger()/updateContext()/
   * setActiveState()/updateActiveStateParams() calls for that layerId are ignored (nothing plays).
   * If it's already playing, this stops it immediately, with the same effect as `stop()`.
   * Re-enabling does not automatically resume playback — ambient/bgm-state layers only start
   * again the next time updateContext()/setActiveState() is called (this simply rides on the
   * caller's existing driving flow; this function itself never creates playback).
   */
  setLayerEnabled(layerId: string, enabled: boolean): void {
    if (enabled) {
      this.disabledLayers.delete(layerId);
      return;
    }
    // Called before adding to disabledLayers so that stop() internally (setActiveState(layerId,
    // undefined) for bgm-state) still executes without being blocked by the guard.
    this.stop(layerId);
    this.disabledLayers.add(layerId);
  }

  /** Whether this has NOT been explicitly disabled via setLayerEnabled() (defaults to true = enabled). */
  isLayerEnabled(layerId: string): boolean {
    return !this.disabledLayers.has(layerId);
  }

  /** Returns all loaded sound-layer IDs (used e.g. by MapboxSoundAdapter to enumerate bind targets) */
  getLayerIds(): string[] {
    return Array.from(this.layers.keys());
  }

  /** Returns the loaded Style's 'bgm-priority-groups' (used e.g. by MapboxSoundAdapter to enumerate bind targets) */
  getBgmPriorityGroups(): BgmPriorityGroup[] {
    return this.bgmPriorityGroups;
  }

  /** Returns the loaded Style's 'proximity-trigger-groups' (used e.g. by MapboxSoundAdapter to enumerate bind targets) */
  getProximityTriggerGroups(): ProximityTriggerGroup[] {
    return this.proximityTriggerGroups;
  }

  /**
   * Returns the loaded Style's sources[].attribution values, deduplicated (in the order they
   * appear in the Style). Intended for apps/UI controls that want to display SE/BGM credits on screen.
   */
  getAttributions(): string[] {
    return this.attributions;
  }

  /**
   * Call this to eagerly load a source that explicitly specifies `load-strategy: 'lazy'` (a
   * source with streaming: true still defaults to 'preload' when unspecified — since no automatic
   * lazy-prefetch trigger is implemented anywhere currently, a source loads normally at load()
   * time unless 'lazy' is explicitly specified) ahead of time (e.g. an Adapter prefetching it as
   * entry into a zone approaches). Even without calling this, if trigger() etc. reference an
   * unloaded source, it only emits an error event and does not auto-load — by design, when to
   * load is a concern left to the Adapter/app side.
   */
  ensureSourceLoaded(sourceId: string): Promise<void> {
    return this.assets.ensureLoaded(sourceId);
  }

  /**
   * Fires a one-shot trigger for an event-type layer (click, hover, etc.).
   * Assumes consistency with layout['sound-trigger'] has already been verified on the adapter side.
   */
  trigger(
    layerId: string,
    context: EvaluationContext = DEFAULT_EVALUATION_CONTEXT,
    meta?: TriggerMeta,
  ): void {
    const runtime = this.requireLayer(layerId, 'event', 'trigger()');
    if (!runtime || this.disabledLayers.has(layerId)) {
      return;
    }
    const layer = runtime.spec as EventSoundLayer;

    const resolved = this.resolveAsset(layer.source, layer['sound-clip'], layerId);
    if (!resolved) {
      return;
    }
    const { asset, clip } = resolved;

    const pitch = runtime.compiledPaint['sound-pitch']?.evaluate(context) ?? 1;
    const volume = runtime.compiledPaint['sound-volume']?.evaluate(context) ?? 1;
    const pan = runtime.compiledPaint['sound-pan']?.evaluate(context) ?? 0;
    const lowpass = runtime.compiledPaint['sound-lowpass']?.evaluate(context);

    const voice = this.buildVoice({
      sourceId: layer.source,
      asset,
      clip,
      pitch,
      initialVolume: volume,
      pan,
      lowpass,
      category: 'se',
    });
    this.setOnEnded(voice, () => {
      // If an early stop() has already run disconnectVoice/delete, don't mistakenly delete an
      // activeEventVoices entry that still points at the same voice (it may have been overwritten
      // by a separate, newer trigger(), so only delete when the voice reference still matches).
      if (this.activeEventVoices.get(layerId) === voice) {
        this.activeEventVoices.delete(layerId);
      }
      this.disconnectVoice(voice);
      this.emit({ type: 'layer:stop', layerId, feature: context.feature, meta });
    });
    this.activeEventVoices.set(layerId, voice);
    this.startVoice(voice, clip, layerId);
    this.emit({ type: 'layer:play', layerId, feature: context.feature, meta });
  }

  /**
   * Updates a given layer's paint/evaluation context. Drives ambient-type layers' continuous
   * volume/pitch changes. Creates a voice on the first call, and only updates its parameters
   * thereafter.
   */
  updateContext(layerId: string, context: EvaluationContext): void {
    const runtime = this.requireLayer(layerId, 'ambient', 'updateContext()');
    if (!runtime || this.disabledLayers.has(layerId)) {
      return;
    }
    const layer = runtime.spec as AmbientSoundLayer;

    const pitch = runtime.compiledPaint['sound-pitch']?.evaluate(context) ?? 1;
    const volume = runtime.compiledPaint['sound-volume']?.evaluate(context) ?? 1;
    const pan = runtime.compiledPaint['sound-pan']?.evaluate(context) ?? 0;
    const lowpass = runtime.compiledPaint['sound-lowpass']?.evaluate(context);

    const existing = this.ambientVoices.get(layerId);
    if (existing) {
      existing.gainNode.gain.value = volume;
      existing.pannerNode.pan.value = pan;
      this.setPlaybackRate(existing, pitch);
      if (lowpass !== undefined && existing.filterNode) {
        existing.filterNode.frequency.value = lowpass;
      }
      return;
    }

    const resolved = this.resolveAsset(layer.source, layer['sound-clip'], layerId);
    if (!resolved) {
      return;
    }
    const loop = layer.layout?.['sound-loop'] ?? true;
    const clip: ClipRange = { ...resolved.clip, loop };

    const voice = this.buildVoice({
      sourceId: layer.source,
      asset: resolved.asset,
      clip,
      pitch,
      initialVolume: volume,
      pan,
      lowpass,
      category: 'ambient',
    });
    this.startVoice(voice, clip, layerId);
    this.ambientVoices.set(layerId, voice);
    this.emit({ type: 'layer:play', layerId });
  }

  /**
   * For a bgm-state layer's currently playing voice, re-evaluates only paint (without changing
   * the state/track) to update sound-volume/pitch/pan/lowpass (the bgm-state equivalent of
   * updateContext()'s ambient version). Call this separately from setActiveState() (which does
   * nothing when the stateKey is unchanged) when you want to vary BGM volume/filter along an axis
   * independent of track switching — for example, a Light preset (dawn/day/dusk/night). Does
   * nothing if there is no voice currently playing.
   */
  updateActiveStateParams(layerId: string, context: EvaluationContext): void {
    const runtime = this.requireLayer(layerId, 'bgm-state', 'updateActiveStateParams()');
    if (!runtime || this.disabledLayers.has(layerId)) {
      return;
    }
    const voice = this.bgmVoices.get(layerId);
    if (!voice) {
      return;
    }

    const pitch = runtime.compiledPaint['sound-pitch']?.evaluate(context) ?? 1;
    const volume = runtime.compiledPaint['sound-volume']?.evaluate(context) ?? 1;
    const pan = runtime.compiledPaint['sound-pan']?.evaluate(context) ?? 0;
    const lowpass = runtime.compiledPaint['sound-lowpass']?.evaluate(context);

    voice.gainNode.gain.value = volume;
    voice.pannerNode.pan.value = pan;
    this.setPlaybackRate(voice, pitch);
    if (lowpass !== undefined && voice.filterNode) {
      voice.filterNode.frequency.value = lowpass;
    }
  }

  /**
   * Switches the active state of a bgm-state layer. If it differs from the current state, fades
   * the old voice out while fading the new voice in, over paint['sound-fade-duration'].
   * If stateKey is undefined, this goes silent (fade-out only).
   */
  setActiveState(
    layerId: string,
    stateKey: string | undefined,
    context: EvaluationContext = DEFAULT_EVALUATION_CONTEXT,
  ): void {
    const runtime = this.requireLayer(layerId, 'bgm-state', 'setActiveState()');
    if (!runtime || (this.disabledLayers.has(layerId) && stateKey !== undefined)) {
      return;
    }
    const layer = runtime.spec as BgmStateSoundLayer;

    const current = this.bgmVoices.get(layerId);
    if (current?.stateKey === stateKey) {
      return;
    }

    const fadeDurationMs = runtime.compiledPaint['sound-fade-duration']?.evaluate(context) ?? 300;
    const fadeSeconds = Math.max(0, fadeDurationMs) / 1000;
    const now = this.audioContext.currentTime;

    if (current) {
      current.gainNode.gain.cancelScheduledValues(now);
      current.gainNode.gain.setValueAtTime(current.gainNode.gain.value, now);
      current.gainNode.gain.linearRampToValueAtTime(0, now + fadeSeconds);
      this.scheduleStop(current, now + fadeSeconds, () => this.disconnectVoice(current));
      this.bgmVoices.delete(layerId);
    }

    if (stateKey === undefined) {
      this.emit({ type: 'layer:stop', layerId });
      return;
    }

    const resolved = this.resolveAsset(layer.source, stateKey, layerId);
    if (!resolved) {
      return;
    }
    const { asset, clip } = resolved;

    const pitch = runtime.compiledPaint['sound-pitch']?.evaluate(context) ?? 1;
    const volume = runtime.compiledPaint['sound-volume']?.evaluate(context) ?? 1;
    const pan = runtime.compiledPaint['sound-pan']?.evaluate(context) ?? 0;
    const lowpass = runtime.compiledPaint['sound-lowpass']?.evaluate(context);

    const voice = this.buildVoice({
      sourceId: layer.source,
      asset,
      clip,
      pitch,
      initialVolume: 0,
      pan,
      lowpass,
      category: 'bgm',
    });
    voice.gainNode.gain.setValueAtTime(0, now);
    voice.gainNode.gain.linearRampToValueAtTime(volume, now + fadeSeconds);
    this.startVoice(voice, clip, layerId);

    this.bgmVoices.set(layerId, { ...voice, stateKey });
    this.emit({ type: 'layer:play', layerId });
  }

  /**
   * Immediately stops the current playback of a given layer (a generic API usable regardless of
   * the layer's type).
   * - `bgm-state`: same as `setActiveState(layerId, undefined)` (fades out over paint's
   *   `sound-fade-duration`).
   * - `ambient`: stops and disconnects immediately (since `ambient` is designed to keep looping
   *   forever, there was previously no way to explicitly stop it — used e.g. for preview playback
   *   in an editing UI).
   * - `event`: if the voice most recently created by `trigger()` is still playing, stops it
   *   immediately (targets only the last of consecutive trigger() calls on the same layer — see
   *   activeEventVoices).
   * Does nothing if the target layer is currently playing nothing.
   */
  stop(layerId: string): void {
    const runtime = this.layers.get(layerId);
    if (!runtime) {
      return;
    }
    if (runtime.spec.type === 'bgm-state') {
      this.setActiveState(layerId, undefined);
      return;
    }
    if (runtime.spec.type === 'ambient') {
      const voice = this.ambientVoices.get(layerId);
      if (!voice) {
        return;
      }
      this.ambientVoices.delete(layerId);
      this.stopVoice(voice, this.audioContext.currentTime);
      this.emit({ type: 'layer:stop', layerId });
      return;
    }
    const voice = this.activeEventVoices.get(layerId);
    if (!voice) {
      return;
    }
    this.activeEventVoices.delete(layerId);
    this.stopVoice(voice, this.audioContext.currentTime);
    this.emit({ type: 'layer:stop', layerId });
  }

  on(type: SoundStyleEngineEvent['type'], handler: EventHandler): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  off(type: SoundStyleEngineEvent['type'], handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispose(): void {
    this.stopAllVoices();
    this.layers.clear();
    this.listeners.clear();
    this.clearPendingStreamingStops();
    this.assets.dispose();
    for (const gain of Object.values(this.categoryGains)) {
      gain.disconnect();
    }
    this.masterGain.disconnect();
  }

  /**
   * Stops and disconnects every currently playing voice, ambient or bgm-state alike. Shared logic
   * used both by a runtime style switch in load() and by dispose() (this prevents a previous
   * style's voices from continuing to play after a switch). A voice already deleted mid-crossfade
   * by setActiveState() (one fading out while waiting on onended) is not in either Map, so it is
   * out of scope here.
   */
  private stopAllVoices(): void {
    const now = this.audioContext.currentTime;
    for (const voice of this.ambientVoices.values()) {
      this.stopVoice(voice, now);
    }
    this.ambientVoices.clear();
    for (const voice of this.bgmVoices.values()) {
      this.stopVoice(voice, now);
    }
    this.bgmVoices.clear();
    for (const voice of this.activeEventVoices.values()) {
      this.stopVoice(voice, now);
    }
    this.activeEventVoices.clear();
  }

  private stopVoice(voice: Voice, when: number): void {
    if (voice.playback.kind === 'buffer') {
      // Clear onended to avoid the handler firing twice, since this stop itself is explicitly
      // called as part of an intentional stop sequence.
      voice.playback.sourceNode.onended = null;
      try {
        voice.playback.sourceNode.stop(when);
      } catch {
        // Cases such as already stopped / not yet started. It's enough to just disconnect.
      }
    } else {
      voice.playback.element.pause();
    }
    this.disconnectVoice(voice);
  }

  /**
   * Stops at a given time (based on AudioContext#currentTime) and calls onStopped once done.
   * For buffer, this uses AudioBufferSourceNode#stop()'s native scheduling. For streaming, there
   * is no stop API that hooks directly into the AudioContext clock (HTMLMediaElement advances on
   * its own media clock), so this is approximated with setTimeout — since it's only used to line
   * up with a fade-out's completion time, a drift of a few ms is not a practical problem.
   */
  private scheduleStop(voice: Voice, atTime: number, onStopped: () => void): void {
    if (voice.playback.kind === 'buffer') {
      voice.playback.sourceNode.onended = onStopped;
      try {
        voice.playback.sourceNode.stop(atTime);
      } catch {
        onStopped();
      }
      return;
    }
    // Because all voices for the same streaming source share the same HTMLAudioElement (see
    // buildVoice), if "go silent -> reactivate the same source (before the fade completes)"
    // happens in quick succession, this scheduled pause() would wrongly stop the new voice's
    // playback (discovered and fixed on real devices on 2026-09-12 — this occurred when
    // re-evaluating a bgm-priority-group made the terrain determination briefly flicker to a
    // different value and then immediately return to the same terrain). This tracks "pending
    // stops" per sourceId, and when a new voice is built against the same source (see buildVoice),
    // it skips pause() and instead immediately performs only the old voice's cleanup, while always
    // canceling this scheduled stop.
    const playback = voice.playback;
    const delayMs = Math.max(0, (atTime - this.audioContext.currentTime) * 1000);
    const timer = setTimeout(() => {
      this.pendingStreamingStops.delete(playback.sourceId);
      playback.element.pause();
      onStopped();
    }, delayMs);
    this.pendingStreamingStops.set(playback.sourceId, { timer, cleanup: onStopped });
  }

  /** Called from buildVoice()'s streaming branch. See scheduleStop(). */
  private cancelPendingStreamingStop(sourceId: string): void {
    const pending = this.pendingStreamingStops.get(sourceId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingStreamingStops.delete(sourceId);
    pending.cleanup();
  }

  /**
   * Called on a runtime Style switch in load(), and from dispose(). Since assets.clear()/
   * dispose() forcibly destroys streaming elements, it's meaningless for an old setTimeout to
   * later fire and call pause() or cleanup() (the state is already a different Style / already
   * disposed) — so the timers themselves are discarded too.
   */
  private clearPendingStreamingStops(): void {
    for (const pending of this.pendingStreamingStops.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingStreamingStops.clear();
  }

  /** Starts playback according to clip.offset/loop. For streaming, watches the Promise from HTMLMediaElement#play(). */
  private startVoice(voice: Voice, clip: ClipRange, layerId: string): void {
    if (voice.playback.kind === 'buffer') {
      voice.playback.sourceNode.start(0, clip.offset, clip.loop ? undefined : clip.duration);
      return;
    }
    const { element } = voice.playback;
    element.currentTime = clip.offset;
    element.play().catch((error: unknown) => {
      this.emit({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        layerId,
      });
    });
  }

  /** Completion notification for non-looping playback. Does not fire for either buffer or streaming when loop: true (native behavior). */
  private setOnEnded(voice: Voice, handler: () => void): void {
    if (voice.playback.kind === 'buffer') {
      voice.playback.sourceNode.onended = handler;
      return;
    }
    voice.playback.element.addEventListener('ended', handler, { once: true });
  }

  /** Branches because buffer's playbackRate is an AudioParam, while streaming's is a plain HTMLMediaElement property. */
  private setPlaybackRate(voice: Voice, pitch: number): void {
    if (voice.playback.kind === 'buffer') {
      voice.playback.sourceNode.playbackRate.value = pitch;
      return;
    }
    voice.playback.element.playbackRate = pitch;
  }

  /** Validates a layer ID against the expected type and returns its LayerRuntime on a match; on a mismatch, emits an error and returns undefined */
  private requireLayer(
    layerId: string,
    expectedType: SoundLayerSpecification['type'],
    apiName: string,
  ): LayerRuntime | undefined {
    const runtime = this.layers.get(layerId);
    if (!runtime) {
      this.emit({ type: 'error', error: new Error(`Unknown sound-layer: ${layerId}`), layerId });
      return undefined;
    }
    if (runtime.spec.type !== expectedType) {
      this.emit({
        type: 'error',
        error: new Error(`${apiName} can only be used on ${expectedType} layers: ${layerId}`),
        layerId,
      });
      return undefined;
    }
    return runtime;
  }

  private resolveAsset(
    source: string,
    clipName: string | undefined,
    layerId: string,
  ): { asset: ResolvedAsset; clip: ClipRange } | undefined {
    const kind = this.assets.getKind(source);
    if (!kind) {
      this.emit({ type: 'error', error: new Error(`Unknown source: ${source}`), layerId });
      return undefined;
    }
    let asset: ResolvedAsset | undefined;
    if (kind === 'buffer') {
      const buffer = this.assets.getBuffer(source);
      asset = buffer ? { kind: 'buffer', buffer } : undefined;
    } else {
      const handle = this.assets.getStreamingHandle(source);
      asset = handle ? { kind: 'streaming', handle } : undefined;
    }
    if (!asset) {
      this.emit({ type: 'error', error: new Error(`Source not loaded: ${source}`), layerId });
      return undefined;
    }
    const clip = this.assets.getClipRange(source, clipName);
    if (!clip) {
      this.emit({
        type: 'error',
        error: new Error(`Clip not found: ${clipName ?? '(none)'}`),
        layerId,
      });
      return undefined;
    }
    return { asset, clip };
  }

  private buildVoice(params: {
    sourceId: string;
    asset: ResolvedAsset;
    clip: ClipRange;
    pitch: number;
    initialVolume: number;
    pan: number;
    lowpass: number | undefined;
    category: SoundCategory;
  }): Voice {
    const { sourceId, asset, clip, pitch, initialVolume, pan, lowpass, category } = params;

    let playback: PlaybackHandle;
    if (asset.kind === 'buffer') {
      const sourceNode = this.audioContext.createBufferSource();
      sourceNode.buffer = asset.buffer;
      sourceNode.playbackRate.value = pitch;
      sourceNode.loop = clip.loop;
      if (clip.loop) {
        sourceNode.loopStart = clip.offset;
        sourceNode.loopEnd = clip.offset + clip.duration;
      }
      playback = { kind: 'buffer', sourceNode };
    } else {
      // Multiple voices referencing the same source can exist simultaneously (e.g. several
      // bgm-state layers referencing the same BGM source), so this is reference-counted on the
      // AssetManager side (the actual HTMLAudioElement is only destroyed on a Style switch/
      // dispose — see release()).
      this.assets.acquire(sourceId);
      // If there's a "pending stop" that was just scheduleStop()'d for this source, we're now
      // building a new voice on the very same HTMLAudioElement, so cancel it before it can
      // pause() (see the comment on scheduleStop() — a bug found on real devices on 2026-09-12).
      this.cancelPendingStreamingStop(sourceId);
      const { element, sourceNode } = asset.handle;
      element.loop = clip.loop;
      element.playbackRate = pitch;
      playback = { kind: 'streaming', sourceId, element, sourceNode };
    }

    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = initialVolume;

    const pannerNode = this.audioContext.createStereoPanner();
    pannerNode.pan.value = pan;

    let lastNode: AudioNode = playback.sourceNode;
    lastNode.connect(gainNode);
    lastNode = gainNode;
    lastNode.connect(pannerNode);
    lastNode = pannerNode;

    let filterNode: BiquadFilterNode | undefined;
    if (lowpass !== undefined) {
      filterNode = this.audioContext.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.value = lowpass;
      lastNode.connect(filterNode);
      lastNode = filterNode;
    }

    lastNode.connect(this.categoryGains[category]);

    return { playback, gainNode, pannerNode, filterNode };
  }

  private disconnectVoice(voice: Voice): void {
    // A streaming sourceNode (MediaElementAudioSourceNode) is reused per source (see buildVoice),
    // so only the connection this particular voice made to gainNode is disconnected (a no-argument
    // disconnect() would cut all connections, and if leaving-then-re-entering happens in quick
    // succession, the delayed disconnect of an old voice mid-fade-out would collaterally cut the
    // connection made by a newer voice attached afterward — found and fixed on 2026-09-12). A
    // buffer's sourceNode belongs exclusively to its voice (a fresh createBufferSource() each
    // time), so this argument form is effectively equivalent to calling it with no argument there too.
    voice.playback.sourceNode.disconnect(voice.gainNode);
    if (voice.playback.kind === 'streaming') {
      this.assets.release(voice.playback.sourceId);
    }
    voice.gainNode.disconnect();
    voice.pannerNode.disconnect();
    voice.filterNode?.disconnect();
  }

  private emit(event: SoundStyleEngineEvent): void {
    for (const handler of this.listeners.get(event.type) ?? []) {
      handler(event);
    }
  }
}
