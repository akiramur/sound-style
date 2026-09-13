// ---------------------------------------------------------------------------
// Expression (adopts the Mapbox Style Spec expression syntax as-is)
// ---------------------------------------------------------------------------
export type ExpressionSpecification = unknown[];

/** A property value that can be either a constant value or an Expression */
export type PropertyValueSpecification<T> = T | ExpressionSpecification;

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/** When the AssetManager fetches a source */
export type AssetLoadStrategy = 'preload' | 'lazy';

/** A source that plays a single audio file as-is */
export interface SingleSoundSource {
  type: 'single';
  /** URL of the audio file (mp3/ogg/wav, etc. — any format AudioContext#decodeAudioData supports) */
  url: string;
  /** Default loop setting (can be overridden by sound-layer.layout['sound-loop']) */
  loop?: boolean;
  /**
   * true: play back via streaming using an HTMLAudioElement + MediaElementAudioSourceNode
   * (intended for BGM/long tracks; does not expand the whole file into memory via
   * decodeAudioData — the browser handles Range requests automatically). false/omitted
   * (default): expand into an AudioBuffer via fetch & decodeAudioData as before (intended
   * for SFX/short sounds). audio-sprite sources cannot have this flag (they are always
   * treated as buffer-based).
   */
  streaming?: boolean;
  /**
   * Only effective when streaming: true. Defaults to 'preload' when omitted (the same
   * default behavior as other sources — since streaming sources don't call
   * decodeAudioData, preloading them doesn't fully expand the BGM into memory either).
   * When explicitly set to 'lazy', the actual fetch for that source doesn't start until
   * `SoundStyleEngine#ensureSourceLoaded()` is called. Note that deciding when to load a
   * lazy source is the caller's (adapter/app's) responsibility — the engine never
   * triggers loading automatically.
   */
  'load-strategy'?: AssetLoadStrategy;
  /**
   * Attribution text for this sound source (HTML string allowed; same format and role as
   * `source.attribution` in the Mapbox GL Style Spec). Collected across all sources and
   * returned by `SoundStyleEngine#getAttributions()`.
   */
  attribution?: string;
}

/** Definition of a single clip within a sprite (offsets in seconds) */
export interface AudioSpriteClipDefinition {
  /** Clip start position (seconds) */
  start: number;
  /** Clip end position (seconds) */
  end: number;
  /** Per-clip loop setting */
  loop?: boolean;
  /** Gain adjustment used e.g. during crossfades (dB, optional) */
  gain?: number;
}

/** A sprite source that packs multiple SFX/BGM clips into a single audio file */
export interface AudioSpriteSoundSource {
  type: 'audio-sprite';
  /** URL of the sprite audio file */
  url: string;
  /** Clip name -> position definition */
  sprite: Record<string, AudioSpriteClipDefinition>;
  /** Attribution text for this sound source (HTML string allowed). See SingleSoundSource.attribution. */
  attribution?: string;
}

export type SoundSourceSpecification = SingleSoundSource | AudioSpriteSoundSource;

// ---------------------------------------------------------------------------
// layout (discrete, non-Expression settings such as triggers and visibility)
// ---------------------------------------------------------------------------

export type SoundTrigger =
  | 'click'
  | 'mouseenter'
  | 'mouseleave'
  | 'zoom-in'
  | 'zoom-out'
  | 'always'
  /**
   * Fires the instant the map's camera movement (flyTo/easeTo/jumpTo, etc.) starts. Has
   * no target-layer/target-featureset (the target is the camera movement itself, not a
   * feature). Any custom properties passed via the second argument (eventData) of
   * `map.flyTo(options, eventData)` become available as feature.properties for `filter`
   * to reference (e.g. `map.flyTo(options, { animationKind: 'flyTo' })` combined with
   * `filter: ['==', ['get', 'animationKind'], 'flyTo']` lets you play different SFX
   * depending on whether flyTo/easeTo/jumpTo was called).
   */
  | 'movestart';

export interface SoundLayerLayoutCommon {
  /** Overall on/off switch for the layer. Equivalent to Mapbox's layout.visibility */
  'sound-visibility'?: 'visible' | 'none';
}

export interface EventLayout extends SoundLayerLayoutCommon {
  /** Firing condition. 'click'/'mouseenter' etc. correspond to Mapbox GL feature events */
  'sound-trigger': SoundTrigger;
  /** Minimum interval (ms) to suppress repeated firing on the same feature */
  'sound-debounce'?: number;
}

export interface AmbientLayout extends SoundLayerLayoutCommon {
  /** Whether to loop continuously (default: true) */
  'sound-loop'?: boolean;
  /** Re-evaluation interval for paint values (ms) */
  'sound-update-interval'?: number;
}

export interface BgmStateLayout extends SoundLayerLayoutCommon {
  /**
   * Which feature property value is used to determine the "currently active state".
   * If a string is given, it's read directly from feature.properties as a raw property
   * name (e.g. "area-id"). If an Expression is given, its evaluation result
   * (string | undefined) is used as the stateKey (e.g. to convert a class value into a
   * terrain type).
   */
  'sound-state-property': string | ExpressionSpecification;
  /** Whether to allow waiting in silence when the state doesn't change */
  'sound-allow-silence'?: boolean;
}

export type SoundLayerLayout = EventLayout | AmbientLayout | BgmStateLayout;

// ---------------------------------------------------------------------------
// paint (values that can change dynamically via Expressions)
// ---------------------------------------------------------------------------

export interface SoundLayerPaint {
  /** Volume. 0-1 (default 1) */
  'sound-volume'?: PropertyValueSpecification<number>;
  /** Playback speed / pitch multiplier. 1 is normal speed (default 1) */
  'sound-pitch'?: PropertyValueSpecification<number>;
  /** Stereo pan. -1 (left) to 1 (right) (default 0) */
  'sound-pan'?: PropertyValueSpecification<number>;
  /** Lowpass filter cutoff frequency (Hz). Filter is disabled if omitted */
  'sound-lowpass'?: PropertyValueSpecification<number>;
  /** Fade/crossfade duration on value change or state transition (ms, default 300) */
  'sound-fade-duration'?: PropertyValueSpecification<number>;
}

// ---------------------------------------------------------------------------
// sound-layers
// ---------------------------------------------------------------------------

/** Specification for targeting a featureset in a Mapbox Standard style (mutually exclusive with target-layer) */
export interface TargetFeaturesetSpecification {
  /** e.g. 'poi', 'place-labels' */
  featuresetId: string;
  /** ID of the style import that provides the featureset (e.g. 'basemap') */
  importId?: string;
}

interface SoundLayerBase {
  /** Unique layer ID */
  id: string;
  /** Key of the source referenced */
  source: string;
  /**
   * Name of the clip to play when using an audio-sprite source.
   * Can be omitted for a single source (plays the whole source if omitted).
   */
  'sound-clip'?: string;
  /**
   * Mapbox GL layer ID(s) targeted for event/data linkage. Mutually exclusive with
   * target-featureset. When given as an array, it represents priority order (first
   * has highest priority) for bgm-state, or the set of target layers for event/ambient.
   */
  'target-layer'?: string | string[];
  /** Specification for targeting a featureset in a Mapbox Standard style. Mutually exclusive with target-layer */
  'target-featureset'?: TargetFeaturesetSpecification;
  /** Mapbox filter expression to narrow down features on target-layer/target-featureset */
  filter?: ExpressionSpecification;
  minzoom?: number;
  maxzoom?: number;
}

export interface EventSoundLayer extends SoundLayerBase {
  type: 'event';
  layout: EventLayout;
  paint?: SoundLayerPaint;
}

export interface AmbientSoundLayer extends SoundLayerBase {
  type: 'ambient';
  layout?: AmbientLayout;
  paint?: SoundLayerPaint;
}

export interface BgmStateSoundLayer extends SoundLayerBase {
  type: 'bgm-state';
  layout: BgmStateLayout;
  paint?: SoundLayerPaint;
}

export type SoundLayerSpecification = EventSoundLayer | AmbientSoundLayer | BgmStateSoundLayer;

// ---------------------------------------------------------------------------
// bgm-priority-groups (multi-dimensional, priority-ordered bgm-state arbitration)
// ---------------------------------------------------------------------------

/**
 * Definition of a single dimension of a BgmPriorityGroup.
 * - 'query': uses the `property` (a raw property name, or an Expression that computes a
 *   stateKey) of the feature found via target-layer/target-featureset as its value (same
 *   shape as bgm-state's sound-state-property).
 * - 'zoom': the current value (number) of map.getZoom().
 * - 'config-property': the current value of a Mapbox Standard style config property
 *   (e.g. scope: 'basemap', 'config-property': 'lightPreset').
 */
export interface BgmPriorityQueryDimension {
  kind: 'query';
  'target-layer'?: string | string[];
  'target-featureset'?: TargetFeaturesetSpecification;
  filter?: ExpressionSpecification;
  property: string | ExpressionSpecification;
}

export interface BgmPriorityZoomDimension {
  kind: 'zoom';
}

export interface BgmPriorityConfigPropertyDimension {
  kind: 'config-property';
  scope: string;
  'config-property': string;
}

export type BgmPriorityDimension =
  | BgmPriorityQueryDimension
  | BgmPriorityZoomDimension
  | BgmPriorityConfigPropertyDimension;

/** A single dimension's worth of the condition a tier must match. A string means exact match; `lte`/`gte` are for numeric dimensions (e.g. zoom) comparisons. */
export type BgmPriorityTierMatchValue = string | { lte: number } | { gte: number };

export interface BgmPriorityTier {
  /** ID of the bgm-state layer to activate when this tier wins */
  layer: string;
  /** This tier wins if all conditions are satisfied. If omitted, it always matches (for use as a fallback). */
  match?: Record<string, BgmPriorityTierMatchValue>;
  /** stateKey to use on activation. Either a fixed string, or {'from-dimension': name} to use the current value of that dimension as-is. */
  state: string | { 'from-dimension': string };
}

export interface BgmPriorityGroup {
  id: string;
  dimensions: Record<string, BgmPriorityDimension>;
  /** In priority order (first is highest priority). The first matching tier wins, activating only its layer and silencing the layers of all other tiers. */
  tiers: BgmPriorityTier[];
}

// ---------------------------------------------------------------------------
// proximity-trigger-groups (radius-based POI detection -> throttling, capping, and staggered firing)
// ---------------------------------------------------------------------------

/** A detection source that reads the category directly from a raw property name/Expression. */
export interface ProximityPropertySource {
  kind: 'property';
  'target-layer'?: string | string[];
  'target-featureset'?: TargetFeaturesetSpecification;
  filter?: ExpressionSpecification;
  /** Raw property name, or an Expression that computes the category string (same shape as bgm-state's sound-state-property). */
  property: string | ExpressionSpecification;
}

/**
 * A detection source that determines the category by matching against the `filter` of
 * existing event-type layers whose IDs share the group's `layer-prefix` (same logic as
 * `findMatchingLayerByPrefix`). To avoid duplicating filter management, this source
 * itself carries no additional field for category determination.
 */
export interface ProximityLayerPrefixSource {
  kind: 'layer-prefix';
  'target-layer'?: string | string[];
  'target-featureset'?: TargetFeaturesetSpecification;
  filter?: ExpressionSpecification;
}

export type ProximitySource = ProximityPropertySource | ProximityLayerPrefixSource;

export interface ProximityTriggerGroup {
  id: string;
  /** Combines detection results from multiple sources and merges them in distance order (e.g. custom POIs + Standard POIs). */
  sources: ProximitySource[];
  /** Detection radius from the map center (meters). */
  'radius-meters': number;
  /** Prefix of the target layer IDs to fire (e.g. 'poi-ping-'). Also used for category resolution with the 'layer-prefix' kind. */
  'layer-prefix': string;
  /** Maximum number of firings per detection cycle. Unlimited if omitted. */
  'max-per-tick'?: number;
  /** Interval (ms) between firings within a cycle. Defaults to 0 (simultaneous firing) if omitted. */
  'stagger-ms'?: number;
  /** Style-level default for whether to prohibit re-firing on the same feature (can be overridden at runtime). Defaults to false if omitted. */
  'once-only'?: boolean;
  /**
   * Outside this zoom range, the detection query itself is not performed (avoids
   * needless queryRenderedFeatures calls — at wide zoom levels, the notion of "POIs near
   * the map center" often doesn't make sense in the first place). No limit if omitted.
   */
  minzoom?: number;
  maxzoom?: number;
  /**
   * While the number of layers fired by this group that are currently playing (whose
   * voice is still sounding) has reached this value, new firings are skipped. Whereas
   * `max-per-tick` is "the cap per single re-evaluation," this is "the cap on
   * simultaneous playback across ticks" — a safety valve for cases where re-evaluation
   * (moveend/sourcedata) fires repeatedly in a short time during pan/zoom, letting the
   * total pile up easily even with a per-tick cap in place (introduced based on
   * real-device feedback on 2026-09-12). Unlimited if omitted.
   */
  'max-concurrent'?: number;
  /**
   * Minimum interval (ms) before an SFX of the same category can fire again. Whereas
   * `once-only` prevents "re-firing on the same feature," this throttles "firing the
   * same category repeatedly in a short time even across different features" (e.g.
   * prevents the 'restaurant' SFX from playing three times in quick succession just
   * because three different restaurants are nearby). No throttling if omitted
   * (introduced based on real-device feedback on 2026-09-12).
   */
  'category-cooldown-ms'?: number;
}

// ---------------------------------------------------------------------------
// document root
// ---------------------------------------------------------------------------

export interface SoundStyleSpecification {
  version: 1;
  name?: string;
  sources: Record<string, SoundSourceSpecification>;
  'sound-layers': SoundLayerSpecification[];
  /** Multi-dimensional, priority-ordered bgm-state arbitration (optional). */
  'bgm-priority-groups'?: BgmPriorityGroup[];
  /** Radius-based POI detection -> throttling, capping, and staggered firing (optional). */
  'proximity-trigger-groups'?: ProximityTriggerGroup[];
}
