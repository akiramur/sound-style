import { featureFilter } from '@mapbox/mapbox-gl-style-spec';
import type {
  ControlPosition,
  FilterSpecification,
  GeoJSONFeature,
  IControl,
  LngLatLike,
  Map as MapboxMap,
  MapLayerMouseEvent,
  MapSourceDataEvent,
  MapStyleDataEvent,
  PointLike,
  TargetFeature,
} from 'mapbox-gl';
import {
  ExpressionEvaluator,
  type AmbientSoundLayer,
  type BgmPriorityDimension,
  type BgmPriorityGroup,
  type BgmPriorityTier,
  type BgmStateSoundLayer,
  type EvaluationContext,
  type EventSoundLayer,
  type ExpressionSpecification,
  type ProximitySource,
  type ProximityTriggerGroup,
  type SoundLayerSpecification,
  type SoundStyleEngine,
  type SoundStyleEngineEvent,
} from '@sound-style/core';

/** Normalizes target-layer (string | string[]) so it is always treated as an array. */
function toLayerArray(targetLayer: string | string[] | undefined): string[] {
  if (!targetLayer) return [];
  return Array.isArray(targetLayer) ? targetLayer : [targetLayer];
}

/**
 * Range check for SoundLayerBase.minzoom/maxzoom. Outside the range, the target-layer/target-featureset
 * itself often has no data present at all (e.g. traffic-lines has no tiles below minzoom 6), so
 * checking this at the top of update() lets us skip pointlessly calling queryRenderedFeatures each
 * time.
 */
function isWithinZoomRange(zoom: number, layer: { minzoom?: number; maxzoom?: number }): boolean {
  return (layer.minzoom === undefined || zoom >= layer.minzoom) && (layer.maxzoom === undefined || zoom <= layer.maxzoom);
}

/**
 * Resolves the set of sourceIds backing the target-layers. Layers not yet added to the map, or things
 * that can't be resolved (like a target-featureset), are ignored — the caller treats an empty set as a
 * safe fallback of "nothing to narrow down to, so re-evaluate on any sourcedata".
 */
function resolveSourceIds(map: MapboxMap, targetLayers: string[]): Set<string> {
  const sourceIds = new Set<string>();
  for (const layerId of targetLayers) {
    const source = (map.getLayer(layerId) as { source?: string } | undefined)?.source;
    if (typeof source === 'string') {
      sourceIds.add(source);
    }
  }
  return sourceIds;
}

/**
 * Builds a compiled expression for evaluating a "property that computes a stateKey" (bgm-state's
 * sound-state-property, or a bgm-priority-groups dimension.property), which can be either a raw
 * property name or an Expression. For a string (raw property name), no compilation is needed, so
 * undefined is returned (the caller just reads the property straight off the feature). An evaluation
 * result of the empty string is treated as "silent state" (stateKey: undefined).
 */
function compileStatePropertyExpression(
  propertyKey: string,
  stateProperty: string | ExpressionSpecification,
): ((context: EvaluationContext) => string | undefined) | undefined {
  if (typeof stateProperty === 'string') {
    return undefined;
  }
  const evaluator = new ExpressionEvaluator({
    propertySpecs: { [propertyKey]: { type: 'string', default: '' } },
  });
  const compiled = evaluator.createPropertyExpression<string>(propertyKey, stateProperty);
  return (context) => {
    const value = compiled.evaluate(context);
    return value === '' || value === null || value === undefined ? undefined : value;
  };
}

/**
 * Determines whether a BgmPriorityTier's match conditions are all satisfied by the resolved dimension
 * values. A tier with no match (the fallback tier) always matches.
 */
function bgmPriorityTierMatches(
  tier: BgmPriorityTier,
  values: Record<string, string | number | undefined>,
): boolean {
  if (!tier.match) return true;
  for (const [dimensionName, condition] of Object.entries(tier.match)) {
    const value = values[dimensionName];
    if (typeof condition === 'string') {
      if (value !== condition) return false;
    } else if ('lte' in condition) {
      if (typeof value !== 'number' || !(value <= condition.lte)) return false;
    } else if ('gte' in condition) {
      if (typeof value !== 'number' || !(value >= condition.gte)) return false;
    }
  }
  return true;
}

export interface MapboxSoundAdapterOptions {
  /** Whether to also re-evaluate ambient/bgm-state during map 'move' (default: moveend/zoomend only) */
  updateDuringMove?: boolean;
  /**
   * Automatically adds the equivalent of `addTerrainQueryLayers` (if not already present). `true` uses
   * the default ids (`TERRAIN_QUERY_LAYER_IDS`); a partial object lets you override individual ids
   * (fields left out keep the default id). Must match the ids used by the terrain dimension of
   * bgm-priority-groups. If any one of the 3 layers already exists, this assumes "the app has already
   * set it up" and does nothing (to avoid collisions/duplicate additions). Only the layers actually
   * added via this option get removed in `destroy()` — layers the app already had are never touched.
   */
  ensureTerrainQueryLayers?: boolean | Partial<TerrainQueryLayerIds>;
  /**
   * Automatically adds the equivalent of `addCountryQueryLayers` (if not already present). `true` uses
   * the default id (`COUNTRY_QUERY_LAYER_ID`); a string lets you override the id. Must match the id
   * used by the country dimension of bgm-priority-groups. Does nothing if it already exists. Only
   * removed in `destroy()` if actually added.
   */
  ensureCountryQueryLayers?: boolean | string;
  /**
   * Called at the start of each proximity-trigger-groups detection cycle (before throttling/capping/
   * once-only are applied). Passes the app every detected category (deduplicated, regardless of
   * whether it actually fired) — this is purely informational, for debug display purposes (e.g. a
   * "nearby categories" list), which is why it's exposed via this option rather than the engine itself:
   * `SoundStyleEngine` has no dependency on the map.
   */
  onProximityDetected?: (event: { groupId: string; categories: string[] }) => void;
  /**
   * Called every time a bgm-priority-group re-evaluates on its own (regardless of whether the trigger
   * was moveend, sourcedata, or styledata). If a debug display relied on moveend alone, it would be
   * left showing stale data whenever the underlying state changed purely because tile loading
   * completed (sourcedata) — this lets the app re-read `getBgmPriorityDimensionValues()` and refresh
   * its display each time (same rationale as `onProximityDetected` — `SoundStyleEngine` itself has no
   * dependency on the map).
   */
  onBgmPriorityUpdate?: (event: { groupId: string }) => void;
}

export type FeatureLike = { id?: string | number; properties: Record<string, unknown> };

/**
 * Builds a matcher, based on layer.filter (the Mapbox Filter Expression given on a sound-layer), for
 * narrowing down features obtained from a click/hover on an event-type layer. ambient/bgm-state don't
 * use this, since they can pass filter directly to queryRenderedFeatures.
 *
 * Also exported so an app that queries features itself via its own queryRenderedFeatures etc. (e.g.
 * when target-featureset doesn't support a radius/bbox query and radius detection must be implemented
 * separately) can reuse the sound-style JSON's own filter as-is to determine the category (so the
 * class/group taxonomy → category mapping isn't maintained twice, once in the JSON and once in the
 * app).
 */
export function createFeatureMatcher(layer: { filter?: SoundLayerSpecification['filter'] }): (
  feature: FeatureLike,
) => boolean {
  if (!layer.filter) {
    return () => true;
  }
  const compiled = featureFilter(layer.filter as never);
  return (feature) =>
    compiled.filter(
      { zoom: 0 } as Parameters<typeof compiled.filter>[0],
      { type: 'Unknown', id: feature.id, properties: feature.properties } as Parameters<
        typeof compiled.filter
      >[1],
    );
}

/**
 * Using `createFeatureMatcher`, walks the layers registered on `engine` whose ID starts with `prefix`
 * in order, and returns the remainder (the suffix, with `prefix` stripped off) of the ID of the first
 * layer whose filter matches `feature`. Used when a sound-style declares the class/group taxonomy →
 * category mapping as filters on a family of layers named `<prefix><category name>` (e.g.
 * `poi-ping-<category>`), so an app can re-evaluate that same mapping against a feature it queried
 * itself via its own queryRenderedFeatures (for cases where target-featureset doesn't support a
 * radius/bbox query and radius detection must be implemented separately). Returns undefined if no
 * layer's filter matches.
 */
export function findMatchingLayerByPrefix(
  engine: SoundStyleEngine,
  prefix: string,
  feature: { properties?: Record<string, unknown> | null },
): string | undefined {
  const featureLike: FeatureLike = { properties: feature.properties ?? {} };
  for (const layerId of engine.getLayerIds()) {
    if (!layerId.startsWith(prefix)) continue;
    const layer = engine.getLayer(layerId);
    if (!layer || !createFeatureMatcher(layer)(featureLike)) continue;
    return layerId.slice(prefix.length);
  }
  return undefined;
}

/** Ground distance in meters per pixel at the given latitude and zoom. The standard Web Mercator approximation. */
export function metersPerPixelAtLat(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** Normalizes any LngLatLike representation (`LngLat`/`[lng,lat]`/`{lng,lat}`/`{lon,lat}`) to `[lng,lat]`. */
function toLngLatTuple(input: LngLatLike): [number, number] {
  if (Array.isArray(input)) return [input[0], input[1]];
  if ('lng' in input) return [input.lng, input.lat];
  return [input.lon, input.lat];
}

/** Ground distance in meters between two points. An equirectangular approximation suited to short ranges of a few hundred meters to a few kilometers (sufficiently accurate, and cheap to compute). */
function distanceMeters(a: LngLatLike, b: LngLatLike): number {
  const [lngA, latA] = toLngLatTuple(a);
  const [lngB, latB] = toLngLatTuple(b);
  const EARTH_RADIUS_METERS = 6371000;
  const lat1 = (latA * Math.PI) / 180;
  const lat2 = (latB * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((lngB - lngA) * Math.PI) / 180;
  const x = dLng * Math.cos((lat1 + lat2) / 2);
  return Math.sqrt(x * x + dLat * dLat) * EARTH_RADIUS_METERS;
}

/** Extracts a feature's representative point (only Point geometry is supported) as `[lng, lat]`. Returns undefined if it can't be obtained. */
export function getFeatureLngLat(feature: {
  geometry?: GeoJSONFeature['geometry'] | null;
}): [number, number] | undefined {
  const geometry = feature.geometry;
  if (!geometry || geometry.type !== 'Point') return undefined;
  return geometry.coordinates as [number, number];
}

export interface RadiusQueryByLayers {
  /** The layer IDs to query (mutually exclusive with `target`). */
  layers: string[];
  target?: undefined;
}

export interface RadiusQueryByTarget {
  layers?: undefined;
  /** The featureset to query (mutually exclusive with `layers`. Only valid for a featureset that supports a radius/bbox query). */
  target: { featuresetId: string; importId?: string };
}

export type RadiusQueryOptions = (RadiusQueryByLayers | RadiusQueryByTarget) & {
  /** Detection radius from the center, in meters. */
  radiusMeters: number;
  /** Detection center. Defaults to `map.getCenter()`. */
  center?: LngLatLike;
  filter?: FilterSpecification;
};

export interface RadiusQueryResult {
  feature: FeatureLike;
  lngLat: [number, number];
  distanceMeters: number;
}

/**
 * Detects features within an actual distance of `radiusMeters` from the given center. Since
 * `queryRenderedFeatures` can't specify a circular range, this first broadly gathers candidates using
 * the screen-space square bounding the circle, then does the actual narrowing-down by each feature's
 * real distance (`distanceMeters`) — using real distance keeps the meaning of "within X meters of the
 * center" consistent regardless of device DPI, window size, or zoom level. Results are sorted
 * nearest-first.
 *
 * Since current Mapbox GL JS doesn't support a radius/bbox query for `target` (featureset), this does
 * not fall back internally to point-query behavior (a single-point queryRenderedFeatures) when
 * `target` is given — it just passes the rectangle straight through to `queryRenderedFeatures` as-is
 * (which may throw if the featureset doesn't support it; the caller should try/catch).
 */
export function queryFeaturesWithinRadius(map: MapboxMap, options: RadiusQueryOptions): RadiusQueryResult[] {
  const center = toLngLatTuple(options.center ?? map.getCenter());
  const centerPoint = map.project(center as LngLatLike);
  const radiusPixels = options.radiusMeters / metersPerPixelAtLat(center[1], map.getZoom());
  const corners: [PointLike, PointLike] = [
    [centerPoint.x - radiusPixels, centerPoint.y - radiusPixels],
    [centerPoint.x + radiusPixels, centerPoint.y + radiusPixels],
  ];

  const rawFeatures: Array<GeoJSONFeature | TargetFeature> = options.target
    ? map.queryRenderedFeatures(corners, { target: options.target, filter: options.filter })
    : map.queryRenderedFeatures(corners, { layers: options.layers, filter: options.filter });

  const results: RadiusQueryResult[] = [];
  for (const feature of rawFeatures) {
    const lngLat = getFeatureLngLat(feature);
    if (!lngLat) continue;
    const distance = distanceMeters(center, lngLat);
    if (distance > options.radiusMeters) continue;
    results.push({
      feature: { id: feature.id, properties: (feature.properties ?? {}) as Record<string, unknown> },
      lngLat,
      distanceMeters: distance,
    });
  }
  return results.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** IDs of the hidden layers added by `addTerrainQueryLayers`. Pass these to `bgm-state`'s `target-layer` (a priority-ordered array). */
export const TERRAIN_QUERY_LAYER_IDS = {
  water: 'terrain-query-water',
  landuse: 'terrain-query-landuse',
  landcover: 'terrain-query-landcover',
} as const;

export interface TerrainQueryLayerIds {
  water: string;
  landuse: string;
  landcover: string;
}

/**
 * Adds hidden layers for water/land-cover detection. Since Mapbox Standard style's internal layers
 * can't be queried from outside their import scope, this works around it by adding the classic
 * tileset equivalents (`mapbox-streets-v8`'s water/landuse, `mapbox-terrain-v2`'s landcover) as our own
 * hidden layers (this avoids the Tilequery API, which incurs extra API charges, and relies only on
 * ordinary tile requests). Since landuse (an urban-planning land-use classification) doesn't cover
 * natural forest away from cities, the landcover layer (general natural land cover) is added as well.
 *
 * Passing `layerIds` lets you override the 3 layer ids individually (e.g. if the app's existing layers
 * collide with the same names; defaults to `TERRAIN_QUERY_LAYER_IDS`). Used on the assumption that
 * `MapboxSoundAdapter`'s `ensureTerrainQueryLayers` option passes the same ids to bgm-priority-groups'
 * dimension.
 *
 * When to call it (e.g. inside `map.on('load', ...)`, after the style has finished loading) and
 * avoiding duplicate additions (deciding not to re-add after `setStyle()`, or when the app already has
 * an equivalent layer) are the caller's responsibility (when used via `MapboxSoundAdapter`,
 * `ensureTerrainQueryLayers` handles this for you).
 */
export function addTerrainQueryLayers(map: MapboxMap, layerIds: TerrainQueryLayerIds = TERRAIN_QUERY_LAYER_IDS): void {
  map.addSource('mapbox-streets-v8', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
  map.addLayer({
    id: layerIds.water,
    type: 'fill',
    source: 'mapbox-streets-v8',
    'source-layer': 'water',
    paint: { 'fill-opacity': 0 },
  });
  map.addLayer({
    id: layerIds.landuse,
    type: 'fill',
    source: 'mapbox-streets-v8',
    'source-layer': 'landuse',
    paint: { 'fill-opacity': 0 },
  });

  map.addSource('mapbox-terrain-v2', { type: 'vector', url: 'mapbox://mapbox.mapbox-terrain-v2' });
  map.addLayer({
    id: layerIds.landcover,
    type: 'fill',
    source: 'mapbox-terrain-v2',
    'source-layer': 'landcover',
    paint: { 'fill-opacity': 0 },
  });
}

/** ID of the hidden layer added by `addCountryQueryLayers` (default; overridable via the `layerId` argument). */
export const COUNTRY_QUERY_LAYER_ID = 'country-query';

/**
 * Adds a hidden layer for country-boundary lookups. Since Mapbox Standard style itself doesn't expose
 * country boundaries via queryRenderedFeatures, this follows the same pattern as
 * `addTerrainQueryLayers`, adding the classic `mapbox.country-boundaries-v1` tileset (country-level
 * boundaries only, free to use without a license) as our own hidden layer. More detailed
 * administrative boundaries (state/province etc.) require a paid Mapbox Boundaries license and are
 * out of scope (country level only).
 *
 * Passing `layerId` lets you override the id (defaults to `COUNTRY_QUERY_LAYER_ID`).
 *
 * When to call it and avoiding duplicate additions are the caller's responsibility, same as with
 * `addTerrainQueryLayers` (when used via `MapboxSoundAdapter`, `ensureCountryQueryLayers` handles this
 * for you).
 */
export function addCountryQueryLayers(map: MapboxMap, layerId: string = COUNTRY_QUERY_LAYER_ID): void {
  map.addSource('mapbox-country-boundaries', { type: 'vector', url: 'mapbox://mapbox.country-boundaries-v1' });
  map.addLayer({
    id: layerId,
    type: 'fill',
    source: 'mapbox-country-boundaries',
    'source-layer': 'country_boundaries',
    paint: { 'fill-opacity': 0 },
  });
}

/**
 * Aggregates the features returned by queryRenderedFeatures into a single composite property set.
 * Numeric properties take the average; everything else (string categories etc.) takes the mode (the
 * most frequent value). Simply using the first feature's value as-is would let the sound get dragged
 * around by whichever single feature happens to be first in queryRenderedFeatures's effectively
 * arbitrary return order, so the mode is used instead to represent the actual state of the view.
 */
function aggregateFeatureProperties(
  features: Array<{ properties?: Record<string, unknown> | null }>,
): Record<string, unknown> {
  const numericSums = new Map<string, number>();
  const numericCounts = new Map<string, number>();
  const categoricalCounts = new Map<string, Map<unknown, number>>();

  for (const feature of features) {
    const properties = feature.properties ?? {};
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === 'number') {
        numericSums.set(key, (numericSums.get(key) ?? 0) + value);
        numericCounts.set(key, (numericCounts.get(key) ?? 0) + 1);
        continue;
      }
      let counts = categoricalCounts.get(key);
      if (!counts) {
        counts = new Map();
        categoricalCounts.set(key, counts);
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const aggregated: Record<string, unknown> = {};
  for (const [key, sum] of numericSums) {
    aggregated[key] = sum / (numericCounts.get(key) ?? 1);
  }
  for (const [key, counts] of categoricalCounts) {
    let bestValue: unknown;
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        bestValue = value;
        bestCount = count;
      }
    }
    aggregated[key] = bestValue;
  }
  return aggregated;
}

/** Converts mapboxgl.Map events into input for the SoundStyleEngine */
export class MapboxSoundAdapter {
  private readonly map: MapboxMap;
  private readonly engine: SoundStyleEngine;
  private readonly options: MapboxSoundAdapterOptions;
  private readonly unbindFns: Array<() => void> = [];
  private readonly lastUpdateAt = new Map<string, number>();
  private readonly lastBgmStateKey = new Map<string, string | undefined>();
  /** The most recently resolved dimension values per bgm-priority-group. Used by getBgmPriorityDimensionValues() (e.g. for debug display). */
  private readonly lastBgmPriorityValues = new Map<string, Record<string, string | number | undefined>>();
  /**
   * The layer id of the tier that was actually most recently making sound (had its state resolved),
   * per bgm-priority-group. Used to exclude "the tier that was actually genuinely playing" from being
   * silenced when the new winning tier's state hasn't been resolved yet (see bindBgmPriorityGroup).
   */
  private readonly lastEffectiveBgmPriorityLayer = new Map<string, string>();
  /** The layer/source ids actually added by ensureTerrainQueryLayers/ensureCountryQueryLayers (recorded only so destroy() can remove exactly those). */
  private readonly ensuredLayerIds: string[] = [];
  private readonly ensuredSourceIds: string[] = [];
  /** Setter used by setProximityOnceOnly(groupId, ...) to update a group-specific once-only override. */
  private readonly proximityOnceOnlySetters = new Map<string, (onceOnly: boolean) => void>();
  private previousZoom: number;

  constructor(
    map: MapboxMap,
    engine: SoundStyleEngine,
    options: MapboxSoundAdapterOptions = {},
  ) {
    this.map = map;
    this.engine = engine;
    this.options = options;
    this.previousZoom = map.getZoom();
    this.applyEnsureLayerOptions(options);

    const bgmPriorityGroups = engine.getBgmPriorityGroups();
    // The bgm-state layers pointed to by a bgm-priority-groups tier should have only that group's
    // arbitration calling setActiveState() (if the normal bindBgmStateLayer also ran its usual
    // target-layer-based auto-update in parallel, it would break the group's premise that "every tier
    // but the winner gets silenced"). So these are excluded from the normal bgm-state binding.
    const priorityManagedLayerIds = new Set(
      bgmPriorityGroups.flatMap((group) => group.tiers.map((tier) => tier.layer)),
    );

    for (const layerId of engine.getLayerIds()) {
      const layer = engine.getLayer(layerId);
      if (!layer) continue;
      if (layer.type === 'event') {
        this.bindEventLayer(layer);
      } else if (layer.type === 'ambient') {
        this.bindAmbientLayer(layer);
      } else if (!priorityManagedLayerIds.has(layerId)) {
        this.bindBgmStateLayer(layer);
      }
    }
    for (const group of bgmPriorityGroups) {
      this.bindBgmPriorityGroup(group);
    }
    for (const group of engine.getProximityTriggerGroups()) {
      this.bindProximityTriggerGroup(group);
    }
  }

  /**
   * Handles the `ensureTerrainQueryLayers`/`ensureCountryQueryLayers` options. Just calls the existing
   * `addTerrainQueryLayers`/`addCountryQueryLayers`, but adds two things on top: (1) does nothing if
   * any of the 3 layers already exists (assumes the app has already set it up — avoiding collisions/
   * duplicate additions), and (2) only when actually added, records the layer/source ids in
   * `ensuredLayerIds`/`ensuredSourceIds` so `destroy()` can remove exactly what it added.
   */
  private applyEnsureLayerOptions(options: MapboxSoundAdapterOptions): void {
    if (options.ensureTerrainQueryLayers) {
      const layerIds: TerrainQueryLayerIds = {
        ...TERRAIN_QUERY_LAYER_IDS,
        ...(typeof options.ensureTerrainQueryLayers === 'object' ? options.ensureTerrainQueryLayers : {}),
      };
      const alreadyPresent =
        this.map.getLayer(layerIds.water) || this.map.getLayer(layerIds.landuse) || this.map.getLayer(layerIds.landcover);
      if (!alreadyPresent) {
        addTerrainQueryLayers(this.map, layerIds);
        this.ensuredLayerIds.push(layerIds.water, layerIds.landuse, layerIds.landcover);
        this.ensuredSourceIds.push('mapbox-streets-v8', 'mapbox-terrain-v2');
      }
    }
    if (options.ensureCountryQueryLayers) {
      const layerId =
        typeof options.ensureCountryQueryLayers === 'string' ? options.ensureCountryQueryLayers : COUNTRY_QUERY_LAYER_ID;
      if (!this.map.getLayer(layerId)) {
        addCountryQueryLayers(this.map, layerId);
        this.ensuredLayerIds.push(layerId);
        this.ensuredSourceIds.push('mapbox-country-boundaries');
      }
    }
  }

  /**
   * The shared re-evaluation binder for ambient/bgm-state/event('always'). In addition to moveend
   * (plus move as well when updateDuringMove is set), also calls update whenever an actual tile data
   * update (sourcedata, sourceDataType: 'content') occurs on a source backing target-layer. This lets
   * it keep up with a vector tile source's background refetch via refreshExpiredTiles even when the
   * map isn't being moved (previously this only watched moveend/zoomend). When sourceId can't be
   * resolved (a target-featureset, or a layer not yet added), it doesn't narrow down and re-evaluates
   * on any sourcedata.
   */
  private bindReevaluate(targetLayers: string[], update: () => void): void {
    this.map.on('moveend', update);
    this.unbindFns.push(() => this.map.off('moveend', update));
    if (this.options.updateDuringMove) {
      this.map.on('move', update);
      this.unbindFns.push(() => this.map.off('move', update));
    }

    // Originally filtered to `sourceDataType === 'content'` only, to avoid reacting to unrelated
    // metadata/visibility churn on the same source — but real-world testing (jumping to an
    // uncached area, then not moving the map again) found that mapbox-gl-js's classic vector-tile
    // sources (the ones addTerrainQueryLayers/addCountryQueryLayers add) never actually fire
    // `sourceDataType: 'content'` at all (it's consistently `undefined` for these, unlike GeoJSON
    // sources, which do use 'content'). That silently broke this entire reevaluate-on-sourcedata
    // mechanism for every classic-tileset-backed layer (bgm-priority-groups' terrain/country
    // dimensions included) — once a moveend landed before those tiles finished loading, nothing
    // would ever re-trigger `update()` again, leaving BGM stuck silent/stale indefinitely. Now
    // reacts to any 'source' sourcedata event for a matching sourceId, regardless of
    // sourceDataType; update() is cheap and every caller already no-ops on an unchanged
    // state/value, so triggering it a bit more often than strictly necessary is harmless.
    const sourceIds = resolveSourceIds(this.map, targetLayers);
    const handler = (e: MapSourceDataEvent) => {
      if (sourceIds.size > 0 && (!e.sourceId || !sourceIds.has(e.sourceId))) {
        return;
      }
      update();
    };
    this.map.on('sourcedata', handler);
    this.unbindFns.push(() => this.map.off('sourcedata', handler));
  }

  private bindEventLayer(layer: EventSoundLayer): void {
    const trigger = layer.layout['sound-trigger'];
    const targetLayers = toLayerArray(layer['target-layer']);
    const targetFeatureset = layer['target-featureset'];
    const matchesFilter = createFeatureMatcher(layer);
    const debounceMs = layer.layout['sound-debounce'] ?? 0;
    const lastFiredAt = new Map<string, number>();

    const fire = (
      feature:
        | { id?: string | number; properties?: Record<string, unknown> | null; geometry?: unknown }
        | undefined,
    ) => {
      // geometry is passed through untouched (not read by matchesFilter/debounce below) purely so
      // engine.trigger()'s emitted layer:play/layer:stop events can carry "where this fired" for
      // apps that want to annotate it (e.g. on the map) without re-querying/re-matching themselves.
      const featureLike: (FeatureLike & { geometry?: unknown }) | undefined = feature && {
        id: feature.id,
        properties: (feature.properties ?? {}) as Record<string, unknown>,
        geometry: feature.geometry,
      };
      if (featureLike && !matchesFilter(featureLike)) {
        return;
      }
      const debounceKey = featureLike?.id !== undefined ? String(featureLike.id) : layer.id;
      if (debounceMs > 0) {
        const now = Date.now();
        const last = lastFiredAt.get(debounceKey);
        if (last !== undefined && now - last < debounceMs) {
          return;
        }
        lastFiredAt.set(debounceKey, now);
      }
      const context: EvaluationContext = { zoom: this.map.getZoom(), feature: featureLike };
      this.engine.trigger(layer.id, context);
    };

    // click/mouseenter/mouseleave/'always' all need a target-layer/target-featureset to watch (no
    // target means nothing to bind to). zoom-in/zoom-out/movestart don't target a feature at
    // all — they react to the map itself (a zoom change / a camera transition starting), so a
    // missing target-layer/target-featureset on those layer types isn't a configuration error.
    const requiresTarget = trigger === 'click' || trigger === 'mouseenter' || trigger === 'mouseleave' || trigger === 'always';
    if (requiresTarget && targetLayers.length === 0 && !targetFeatureset) {
      return;
    }

    if (trigger === 'click' || trigger === 'mouseenter' || trigger === 'mouseleave') {
      if (targetFeatureset) {
        // target-featureset is click/hover detection via addInteraction, targeting a Standard style
        // featureset (POI etc). Mutually exclusive with target-layer.
        const interactionId = `sound-style:${layer.id}`;
        this.map.addInteraction(interactionId, {
          type: trigger,
          target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
          // mapbox-gl-js's Interactions API treats an event as "consumed" unless the handler
          // explicitly returns false, which stops it from propagating to other interactions
          // registered on the same target (other categories' poi-ping-*, or an interaction the app
          // added separately). Always return false so multiple sound-style layers can share the same
          // target-featureset.
          handler: (event) => {
            fire(event.feature);
            return false;
          },
        });
        this.unbindFns.push(() => this.map.removeInteraction(interactionId));
        return;
      }
      const targets: string | string[] = targetLayers.length === 1 ? (targetLayers[0] as string) : targetLayers;
      const handler = (e: MapLayerMouseEvent) => fire(e.features?.[0]);
      this.map.on(trigger, targets, handler);
      this.unbindFns.push(() => this.map.off(trigger, targets, handler));
    } else if (trigger === 'zoom-in' || trigger === 'zoom-out') {
      const handler = () => {
        const zoom = this.map.getZoom();
        const isMatch =
          (trigger === 'zoom-in' && zoom > this.previousZoom) ||
          (trigger === 'zoom-out' && zoom < this.previousZoom);
        this.previousZoom = zoom;
        if (isMatch) {
          fire(undefined);
        }
      };
      this.map.on('zoomend', handler);
      this.unbindFns.push(() => this.map.off('zoomend', handler));
    } else if (trigger === 'always') {
      // Rather than a browser event like a click, this fires based on the map moving or its data
      // updating (bindReevaluate), using the first feature found on target-layer/target-featureset at
      // that moment. A trigger meant for an event like a traffic SE that should "keep following data
      // changes even while stationary" (the actual intent being: only when the state changes, not on
      // every re-evaluation).
      // Only fires when the id of "the first feature found" has changed since last time (found and
      // fixed on a real device on 2026-09-12: while the same traffic segment stayed in view, it kept
      // sounding on every sourcedata re-evaluation — roughly every tile-refresh interval, about a
      // minute in practice. sound-debounce is a time-based throttle and can't detect that "the state
      // hasn't changed", so this separate change-detection was needed). If no feature is found at all,
      // resets so that the same or a different feature found again later can fire again.
      let lastFiredFeatureKey: string | undefined;
      const update = () => {
        if (!isWithinZoomRange(this.map.getZoom(), layer)) return;
        const features = targetFeatureset
          ? this.map.queryRenderedFeatures({
              target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
              filter: layer.filter as FilterSpecification | undefined,
            })
          : this.map.queryRenderedFeatures({
              layers: targetLayers,
              filter: layer.filter as FilterSpecification | undefined,
            });
        const feature = features[0];
        if (!feature) {
          lastFiredFeatureKey = undefined;
          return;
        }
        const featureKey = feature.id !== undefined ? String(feature.id) : JSON.stringify(feature.properties ?? {});
        if (featureKey === lastFiredFeatureKey) {
          return;
        }
        lastFiredFeatureKey = featureKey;
        fire(feature);
      };
      this.bindReevaluate(targetLayers, update);
      update();
    } else if (trigger === 'movestart') {
      // Fires the instant a camera transition (flyTo/easeTo/jumpTo/panBy/...) starts — no
      // target-layer/target-featureset involved, since this is about the camera, not a feature.
      // Whatever extra `eventData` the caller passed as the transition's second argument
      // (e.g. `map.flyTo(options, { animationKind: 'flyTo' })`) is merged directly onto the fired
      // 'movestart' event object by mapbox-gl-js, so it's exposed here as `feature.properties` —
      // letting `filter` pick it apart (e.g. `['==', ['get', 'animationKind'], 'flyTo']`) the same
      // way a click-triggered layer's filter picks apart a real feature's properties.
      const handler = (event: Record<string, unknown>) => fire({ properties: event });
      this.map.on('movestart', handler);
      this.unbindFns.push(() => this.map.off('movestart', handler));
    }
  }

  private bindAmbientLayer(layer: AmbientSoundLayer): void {
    const targetLayers = toLayerArray(layer['target-layer']);
    const targetFeatureset = layer['target-featureset'];
    // No target-layer/target-featureset means there's no map feature to derive context from — the
    // layer is meant to be driven entirely by the app's own engine.updateContext() calls (e.g. a
    // weather select feeding a non-geometry app state into paint). Auto-reevaluating on
    // zoom/move/sourcedata here would call updateContext(layer.id, { zoom }) with no `feature`,
    // clobbering whatever properties the app last set and silently resetting paint expressions like
    // ['match', ['get', 'weather'], ...] to their default arm on the very next map interaction.
    // bindBgmStateLayer already has this same early-return for the same reason (see below).
    if (targetLayers.length === 0 && !targetFeatureset) {
      return;
    }
    const updateIntervalMs = layer.layout?.['sound-update-interval'] ?? 0;

    const update = () => {
      if (updateIntervalMs > 0) {
        const now = Date.now();
        const last = this.lastUpdateAt.get(layer.id);
        if (last !== undefined && now - last < updateIntervalMs) {
          return;
        }
        this.lastUpdateAt.set(layer.id, now);
      }

      const zoom = this.map.getZoom();
      if (!isWithinZoomRange(zoom, layer)) return;

      const features = targetFeatureset
        ? this.map.queryRenderedFeatures({
            target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
            filter: layer.filter as FilterSpecification | undefined,
          })
        : this.map.queryRenderedFeatures({
            layers: targetLayers,
            filter: layer.filter as FilterSpecification | undefined,
          });

      if (features.length === 0) {
        this.engine.updateContext(layer.id, { zoom });
        return;
      }

      this.engine.updateContext(layer.id, {
        zoom,
        feature: { properties: aggregateFeatureProperties(features) },
      });
    };

    this.bindReevaluate(targetLayers, update);
    update();
  }

  private bindBgmStateLayer(layer: BgmStateSoundLayer): void {
    const targetLayers = toLayerArray(layer['target-layer']);
    const targetFeatureset = layer['target-featureset'];
    if (targetLayers.length === 0 && !targetFeatureset) {
      return;
    }
    const stateProperty = layer.layout['sound-state-property'];
    const stateExpression = compileStatePropertyExpression('sound-state-property', stateProperty);
    const allowSilence = layer.layout['sound-allow-silence'] ?? true;

    const update = () => {
      const zoom = this.map.getZoom();
      const centerPoint = this.map.project(this.map.getCenter());
      let feature: { id?: string | number; properties?: Record<string, unknown> | null } | undefined;

      if (!isWithinZoomRange(zoom, layer)) {
        // Out of range: leave `feature` undefined, as if nothing were found — the existing
        // sound-allow-silence logic below already handles that case correctly.
      } else if (targetFeatureset) {
        const features = this.map.queryRenderedFeatures(centerPoint, {
          target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
          filter: layer.filter as FilterSpecification | undefined,
        });
        feature = features[0];
      } else {
        // targetLayers is priority-ordered: check from the front, and use the first layer where a feature is found.
        for (const targetLayer of targetLayers) {
          const features = this.map.queryRenderedFeatures(centerPoint, {
            layers: [targetLayer],
            filter: layer.filter as FilterSpecification | undefined,
          });
          if (features.length > 0) {
            feature = features[0];
            break;
          }
        }
      }

      const stateKey = stateExpression
        ? stateExpression({
            zoom,
            feature: feature && { id: feature.id, properties: (feature.properties ?? {}) as Record<string, unknown> },
          })
        : (feature?.properties as Record<string, unknown> | null)?.[stateProperty as string] as
            | string
            | undefined;

      if (this.lastBgmStateKey.has(layer.id) && this.lastBgmStateKey.get(layer.id) === stateKey) {
        return;
      }
      if (stateKey === undefined && !allowSilence) {
        return;
      }
      this.lastBgmStateKey.set(layer.id, stateKey);
      this.engine.setActiveState(layer.id, stateKey, { zoom });
    };

    this.bindReevaluate(targetLayers, update);
    update();
  }

  /**
   * Arbitrates a single bgm-priority-groups group. Resolves every dimension to its current value, and
   * treats the first tier (checked in order) whose match holds as the "winner", making only that
   * tier's layer active via setActiveState() and silencing every other tier's layer in the group
   * (setActiveState(..., undefined)). If no tier matches, or the winner's state can't be resolved (e.g.
   * the fallback tier's from-dimension is still undetermined), does nothing (equivalent to
   * bindBgmStateLayer's sound-allow-silence: false — lets whatever BGM was playing just before
   * continue unchanged).
   */
  private bindBgmPriorityGroup(group: BgmPriorityGroup): void {
    const dimensionNames = Object.keys(group.dimensions);
    const targetLayers = dimensionNames.flatMap((name) => {
      const dimension = group.dimensions[name] as BgmPriorityDimension;
      return dimension.kind === 'query' ? toLayerArray(dimension['target-layer']) : [];
    });
    const hasConfigPropertyDimension = dimensionNames.some(
      (name) => (group.dimensions[name] as BgmPriorityDimension).kind === 'config-property',
    );

    const update = () => {
      const values: Record<string, string | number | undefined> = {};
      for (const name of dimensionNames) {
        values[name] = this.resolveBgmPriorityDimension(group.dimensions[name] as BgmPriorityDimension);
      }
      this.lastBgmPriorityValues.set(group.id, values);
      this.options.onBgmPriorityUpdate?.({ groupId: group.id });

      const winner = group.tiers.find((tier) => bgmPriorityTierMatches(tier, values));
      if (!winner) {
        return;
      }
      const winningState =
        typeof winner.state === 'string' ? winner.state : (values[winner.state['from-dimension']] as
            | string
            | undefined);

      const context: EvaluationContext = { zoom: this.map.getZoom() };
      const lastEffectiveLayer = this.lastEffectiveBgmPriorityLayer.get(group.id);

      if (winningState !== undefined) {
        // We have a definitive new sound to play: this is the only point at which it's safe to
        // silence every other tier (including whichever tier was actually audible a moment ago —
        // see the `else` branch below for why that one is normally exempt), since we're handing
        // the mic to a real replacement rather than to silence.
        for (const tier of group.tiers) {
          if (tier.layer !== winner.layer) {
            this.engine.setActiveState(tier.layer, undefined, context);
          }
        }
        this.engine.setActiveState(winner.layer, winningState, context);
        this.lastEffectiveBgmPriorityLayer.set(group.id, winner.layer);
      } else {
        // The winning tier's own state can't be resolved yet (e.g. the fallback tier's
        // from-dimension value is momentarily undetermined — no feature found at this point,
        // such as a gap in landcover data). We must still silence any tier whose `match` no
        // longer holds (e.g. world-view, once zoom is back above the threshold) so it doesn't
        // get stuck playing forever — EXCEPT the one tier that was actually audible a moment ago
        // (`lastEffectiveLayer`), which must keep playing rather than being cut with nothing to
        // replace it. Once a future update resolves a real winningState, that tier finally gets
        // silenced properly above.
        for (const tier of group.tiers) {
          if (tier.layer !== winner.layer && tier.layer !== lastEffectiveLayer) {
            this.engine.setActiveState(tier.layer, undefined, context);
          }
        }
      }
    };

    this.bindReevaluate(targetLayers, update);
    if (hasConfigPropertyDimension) {
      const handler = (e: MapStyleDataEvent) => {
        if (e.dataType === 'style') update();
      };
      this.map.on('styledata', handler);
      this.unbindFns.push(() => this.map.off('styledata', handler));
    }
    update();
  }

  /** Resolves a single bgm-priority-group dimension to its current value (query is a single point at the map center — the same convention as bindBgmStateLayer). */
  private resolveBgmPriorityDimension(dimension: BgmPriorityDimension): string | number | undefined {
    if (dimension.kind === 'zoom') {
      return this.map.getZoom();
    }
    if (dimension.kind === 'config-property') {
      return this.map.getConfigProperty(dimension.scope, dimension['config-property']) as
        | string
        | undefined;
    }

    const targetLayers = toLayerArray(dimension['target-layer']);
    const targetFeatureset = dimension['target-featureset'];
    const centerPoint = this.map.project(this.map.getCenter());
    let feature: { id?: string | number; properties?: Record<string, unknown> | null } | undefined;

    if (targetFeatureset) {
      const features = this.map.queryRenderedFeatures(centerPoint, {
        target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
        filter: dimension.filter as FilterSpecification | undefined,
      });
      feature = features[0];
    } else {
      for (const targetLayer of targetLayers) {
        const features = this.map.queryRenderedFeatures(centerPoint, {
          layers: [targetLayer],
          filter: dimension.filter as FilterSpecification | undefined,
        });
        if (features.length > 0) {
          feature = features[0];
          break;
        }
      }
    }

    // No feature found at all (nothing at this point in any target-layer/target-featureset — e.g.
    // tiles not loaded yet) must stay undefined, distinct from "found a feature with no matching
    // property" (an Expression like `['!', ['has', 'class']]` can't tell those apart on its own,
    // since a missing `feature` in the evaluation context and a feature with no `class` property
    // both make `has('class')` false).
    if (!feature) {
      return undefined;
    }

    const propertyExpression = compileStatePropertyExpression('bgm-priority-dimension', dimension.property);
    if (propertyExpression) {
      return propertyExpression({
        zoom: this.map.getZoom(),
        feature: feature && { id: feature.id, properties: (feature.properties ?? {}) as Record<string, unknown> },
      });
    }
    return (feature?.properties as Record<string, unknown> | null)?.[dimension.property as string] as
      | string
      | undefined;
  }

  /**
   * Returns the current value of each dimension most recently resolved for the given
   * bgm-priority-group (a read-only API for things like debug display, so the app doesn't have to
   * issue the same query a second time). Returns undefined if it has never been updated, or the group
   * doesn't exist.
   */
  getBgmPriorityDimensionValues(groupId: string): Record<string, string | number | undefined> | undefined {
    return this.lastBgmPriorityValues.get(groupId);
  }

  /**
   * Binds a single proximity-trigger-group. On every moveend/sourcedata, queries each of
   * group.sources via `queryFeaturesWithinRadius`, resolves a category for each result ('property':
   * a raw property/Expression; 'layer-prefix': matched against existing event-type layers' filters
   * using the same logic as `findMatchingLayerByPrefix`), and merges them in distance order. Processes
   * in this order: `onProximityDetected` (every category, before throttling) → narrow down to the
   * single nearest candidate per category → once-only (exclude already-fired features) →
   * category-cooldown-ms (throttle repeat firing of the same category) → trim by
   * max-per-tick/max-concurrent (whichever is smaller of the per-tick cap and the cross-tick concurrent
   * playback cap), and finally fires the remaining candidates staggered by stagger-ms each, via
   * `engine.trigger('<layer-prefix><category>', ..., { source: 'proximity' })`.
   */
  private bindProximityTriggerGroup(group: ProximityTriggerGroup): void {
    const targetLayersForReevaluate = group.sources.flatMap((source) => toLayerArray(source['target-layer']));
    const triggeredKeys = new Set<string>();
    let onceOnlyOverride: boolean | undefined;
    this.proximityOnceOnlySetters.set(group.id, (onceOnly) => {
      onceOnlyOverride = onceOnly;
    });

    // The denominator for max-concurrent. Tracks, via the engine's own layer:play/layer:stop events,
    // whether a layer this group could fire (`${layer-prefix}${category}`) is currently playing — a
    // layer currently playing because of a tap click also counts here (the goal is to cap the total
    // number of sounds actually playing, regardless of whether the trigger path was proximity or
    // something else).
    const activePlayingLayerIds = new Set<string>();
    const isOwnLayer = (layerId: string) => layerId.startsWith(group['layer-prefix']);
    const onLayerPlay = (event: SoundStyleEngineEvent) => {
      if (event.type === 'layer:play' && isOwnLayer(event.layerId)) activePlayingLayerIds.add(event.layerId);
    };
    const onLayerStop = (event: SoundStyleEngineEvent) => {
      if (event.type === 'layer:stop' && isOwnLayer(event.layerId)) activePlayingLayerIds.delete(event.layerId);
    };
    this.engine.on('layer:play', onLayerPlay);
    this.engine.on('layer:stop', onLayerStop);
    this.unbindFns.push(() => {
      this.engine.off('layer:play', onLayerPlay);
      this.engine.off('layer:stop', onLayerStop);
    });

    // The denominator for category-cooldown-ms. Manages the re-fire interval per category, on a
    // separate axis from once-only (which is per feature).
    const lastFiredAtByCategory = new Map<string, number>();

    const resolveCategory = (source: ProximitySource, feature: FeatureLike): string | undefined => {
      if (source.kind === 'property') {
        const propertyExpression = compileStatePropertyExpression('proximity-category', source.property);
        if (propertyExpression) {
          return propertyExpression({ zoom: this.map.getZoom(), feature });
        }
        return (feature.properties as Record<string, unknown>)[source.property as string] as string | undefined;
      }
      return findMatchingLayerByPrefix(this.engine, group['layer-prefix'], feature);
    };

    interface Candidate {
      category: string;
      feature: FeatureLike;
      lngLat: [number, number];
      distanceMeters: number;
      key: string;
    }

    const update = () => {
      // Outside the configured zoom range, "the POIs near the map center" isn't a meaningful
      // concept (e.g. zoomed out to a whole country) and running the radius queries would just be
      // wasted work — skip entirely, reporting no detections so the debug panel doesn't show stale
      // data from a different zoom level.
      const zoom = this.map.getZoom();
      if ((group.minzoom !== undefined && zoom < group.minzoom) || (group.maxzoom !== undefined && zoom > group.maxzoom)) {
        this.options.onProximityDetected?.({ groupId: group.id, categories: [] });
        return;
      }

      const candidates: Candidate[] = [];
      for (const source of group.sources) {
        const targetLayers = toLayerArray(source['target-layer']);
        const targetFeatureset = source['target-featureset'];
        let results: RadiusQueryResult[];
        try {
          results = targetFeatureset
            ? queryFeaturesWithinRadius(this.map, {
                target: { featuresetId: targetFeatureset.featuresetId, importId: targetFeatureset.importId },
                radiusMeters: group['radius-meters'],
                filter: source.filter as FilterSpecification | undefined,
              })
            : queryFeaturesWithinRadius(this.map, {
                layers: targetLayers,
                radiusMeters: group['radius-meters'],
                filter: source.filter as FilterSpecification | undefined,
              });
        } catch (error) {
          // A target-featureset query can fail on styles other than Standard — skip this source for
          // this cycle rather than throwing.
          console.warn('[sound-style] proximity-trigger-group source query failed:', error);
          continue;
        }
        for (const { feature, lngLat, distanceMeters } of results) {
          const category = resolveCategory(source, feature);
          if (!category) continue;
          const key = `${category}:${feature.id ?? (feature.properties as Record<string, unknown>).name ?? 'unknown'}`;
          candidates.push({ category, feature, lngLat, distanceMeters, key });
        }
      }

      candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);

      this.options.onProximityDetected?.({
        groupId: group.id,
        categories: Array.from(new Set(candidates.map((c) => c.category))),
      });

      const onceOnly = onceOnlyOverride ?? group['once-only'] ?? false;
      const categoryCooldownMs = group['category-cooldown-ms'] ?? 0;
      const now = Date.now();
      const byCategory = new Map<string, Candidate>();
      for (const candidate of candidates) {
        if (byCategory.has(candidate.category)) continue;
        if (onceOnly && triggeredKeys.has(candidate.key)) continue;
        if (categoryCooldownMs > 0) {
          const lastFiredAt = lastFiredAtByCategory.get(candidate.category);
          if (lastFiredAt !== undefined && now - lastFiredAt < categoryCooldownMs) continue;
        }
        byCategory.set(candidate.category, candidate);
      }

      const maxPerTick = group['max-per-tick'] ?? Infinity;
      const staggerMs = group['stagger-ms'] ?? 0;
      // max-concurrent is "the cap on concurrent playback across ticks" — subtract the number already
      // playing to get the remaining slots, then further intersect that with max-per-tick (whichever
      // is smaller becomes the actual cap).
      const maxConcurrent = group['max-concurrent'] ?? Infinity;
      const availableSlots = Math.max(0, maxConcurrent - activePlayingLayerIds.size);
      const selected = Array.from(byCategory.values()).slice(0, Math.min(maxPerTick, availableSlots));

      selected.forEach((candidate, index) => {
        const layerId = `${group['layer-prefix']}${candidate.category}`;
        const fire = () => {
          if (!this.engine.getLayer(layerId)) return;
          triggeredKeys.add(candidate.key);
          lastFiredAtByCategory.set(candidate.category, Date.now());
          this.engine.trigger(
            layerId,
            {
              zoom: this.map.getZoom(),
              feature: { ...candidate.feature, geometry: { type: 'Point', coordinates: candidate.lngLat } },
            },
            { source: 'proximity' },
          );
        };
        if (staggerMs > 0) {
          setTimeout(fire, index * staggerMs);
        } else {
          fire();
        }
      });
    };

    this.bindReevaluate(targetLayersForReevaluate, update);
    update();
  }

  /**
   * Overrides a proximity-trigger-group's `once-only` (the Style's default value) at runtime (for a
   * case like a UI toggle that lets the user switch it on/off).
   */
  setProximityOnceOnly(groupId: string, onceOnly: boolean): void {
    this.proximityOnceOnlySetters.get(groupId)?.(onceOnly);
  }

  /** Detaches the adapter, removing all event listeners from the map */
  destroy(): void {
    for (const unbind of this.unbindFns.splice(0)) {
      unbind();
    }
    // Only removes what ensureTerrainQueryLayers/ensureCountryQueryLayers actually added — never a
    // layer/source the app already had (those were left untouched at construction time, and stay
    // untouched here too). Layers before sources: Mapbox GL throws if a source is removed while a
    // layer still references it. Guarded with getLayer/getSource in case a setStyle() in between
    // already wiped them (removeLayer/removeSource would otherwise throw on a missing id).
    for (const layerId of this.ensuredLayerIds.splice(0)) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    for (const sourceId of this.ensuredSourceIds.splice(0)) {
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    }
    this.lastBgmPriorityValues.clear();
    this.lastUpdateAt.clear();
    this.lastBgmStateKey.clear();
    this.proximityOnceOnlySetters.clear();
  }
}

/**
 * An IControl implementation that displays SE/BGM credit text (sources[].attribution). Matches
 * Mapbox's native AttributionControl in look and behavior (bottom-right placement, collapsing on
 * icon click) while coexisting as an independent control (there's no option to merge the two).
 * Re-reads `engine.getAttributions()` and redraws every time load completes (the initial load, and
 * any runtime Style switch). Hides the control entirely on a Style with no source that has an
 * attribution.
 */
export class SoundAttributionControl implements IControl {
  private readonly engine: SoundStyleEngine;
  private container?: HTMLElement;
  private list?: HTMLUListElement;
  private readonly onLoad = () => this.render();

  constructor(engine: SoundStyleEngine) {
    this.engine = engine;
  }

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    // Deliberately not `mapboxgl-ctrl-group` (that class paints an opaque white toolbar background
    // meant for button groups) — Mapbox's own AttributionControl doesn't use it either, so
    // `.sound-style-attrib`'s own background/font (aligned to `.mapboxgl-ctrl-attrib`'s look in the
    // app's stylesheet) is what actually renders.
    container.className = 'mapboxgl-ctrl sound-style-attrib';

    // Collapsed state: a round icon button (rounded-corner pill, matching mapboxgl-ctrl-attrib's
    // own compact/collapsed look). Hidden once expanded (`sound-style-attrib--open`), replaced by
    // the close button below — clicking the same toggle to re-close would put the "X" in the same
    // visual slot the note icon used to occupy, which reads as if it toggles the whole control
    // rather than just dismissing the expanded panel.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sound-style-attrib-toggle';
    toggle.setAttribute('aria-label', 'Sound attribution');
    toggle.textContent = '♪';
    toggle.addEventListener('click', () => {
      container.classList.add('sound-style-attrib--open');
    });

    // Expanded state: a dedicated close ("X") button in the panel's top-right corner (standard
    // placement for a dismiss control in a LTR UI), rather than reusing the toggle as an open/close
    // switch.
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sound-style-attrib-close';
    close.setAttribute('aria-label', 'Close sound attribution');
    close.textContent = '✕';
    close.addEventListener('click', () => {
      container.classList.remove('sound-style-attrib--open');
    });

    const list = document.createElement('ul');
    list.className = 'sound-style-attrib-list';

    const panel = document.createElement('div');
    panel.className = 'sound-style-attrib-panel';
    panel.appendChild(close);
    panel.appendChild(list);

    container.appendChild(toggle);
    container.appendChild(panel);

    this.container = container;
    this.list = list;
    this.engine.on('load', this.onLoad);
    this.render();
    return container;
  }

  onRemove(): void {
    this.engine.off('load', this.onLoad);
    this.container?.remove();
    this.container = undefined;
    this.list = undefined;
  }

  getDefaultPosition(): ControlPosition {
    return 'bottom-right';
  }

  /**
   * attribution is an HTML string specified by the Style author (the same convention as Mapbox GL
   * Style Spec's source.attribution), not user input, so assigning it via innerHTML is fine.
   */
  private render(): void {
    if (!this.list || !this.container) return;
    const attributions = this.engine.getAttributions();
    this.list.innerHTML = '';
    for (const attribution of attributions) {
      const item = document.createElement('li');
      item.innerHTML = attribution;
      this.list.appendChild(item);
    }
    this.container.style.display = attributions.length > 0 ? '' : 'none';
  }
}
