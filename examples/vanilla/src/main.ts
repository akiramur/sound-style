import mapboxgl from 'mapbox-gl';
import type { GeoJSONFeature } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { SoundStyleEngine, validateSoundStyle, type SoundCategory, type SoundStyleSpecification } from '@sound-style/core';
import { getFeatureLngLat, MapboxSoundAdapter, metersPerPixelAtLat, SoundAttributionControl } from '@sound-style/mapbox-gl';
import { poiGeoJson } from './poi-data.js';

/**
 * This app only ever loads a compiled sound-style.json artifact at runtime — the same way any
 * user bringing their own Style would — rather than authoring the Style inline in application
 * code.
 */
async function loadSoundStyle(): Promise<SoundStyleSpecification> {
  const response = await fetch('/styles/sound-style-basic.json');
  return validateSoundStyle(await response.json());
}

// Fallback for when #master-volume isn't found in the DOM — kept in sync with its `value` attribute
// in index.html.
const DEFAULT_MASTER_VOLUME = 0.6;

/**
 * Debug-UI-only threshold that conceptually belongs to the Style, not this app — rather than
 * hardcoding a copy here that could silently drift from the real value, it's read directly out of
 * the fetched Style JSON once (see loadDebugUiThresholds, called from main()) and kept here as
 * mutable state with a same-as-Style-default fallback for the brief window before that resolves.
 * This doesn't affect actual sound-style behavior (that's entirely the SDK's/Style's own doing) —
 * it only decides when the local-time/Light-preset auto-sync suspends at world view.
 */
let worldViewZoomThreshold = 2; // AREA_BGM_PRIORITY_GROUP's world-view tier: match.zoom.lte
let poiDetectionRadiusMeters = 500; // POI_PROXIMITY_TRIGGER_GROUP['radius-meters']
let poiProximityMinzoom = 11; // POI_PROXIMITY_TRIGGER_GROUP['minzoom']

/**
 * Reads worldViewZoomThreshold/poiDetectionRadiusMeters/poiProximityMinzoom out of the actual
 * fetched Style JSON, so the debug UI never drifts from the real
 * values. Fetches independently of starting sound-style itself (no AudioContext/audio permission
 * involved — this runs before "Enable audio" is ever clicked, since the debug panel is live from
 * page load) via the same loadSoundStyle() used to actually start the engine later.
 */
async function loadDebugUiThresholds(): Promise<void> {
  const style = await loadSoundStyle();
  const worldViewTier = style['bgm-priority-groups']
    ?.find((group) => group.id === 'area-bgm-priority')
    ?.tiers.find((tier) => tier.layer === 'world-view-bgm-override');
  const zoomMatch = worldViewTier?.match?.zoom;
  if (typeof zoomMatch === 'object' && 'lte' in zoomMatch) {
    worldViewZoomThreshold = zoomMatch.lte;
  }

  const proximityGroup = style['proximity-trigger-groups']?.find((group) => group.id === 'poi-proximity');
  if (proximityGroup) {
    poiDetectionRadiusMeters = proximityGroup['radius-meters'];
    if (proximityGroup.minzoom !== undefined) poiProximityMinzoom = proximityGroup.minzoom;
  }
}

const statusEl = document.querySelector<HTMLParagraphElement>('#status');
const enableAudioButton = document.querySelector<HTMLButtonElement>('#enable-audio');
const volumeRow = document.querySelector<HTMLDivElement>('#volume-row');
const volumeInput = document.querySelector<HTMLInputElement>('#master-volume');
const categoryToggleRow = document.querySelector<HTMLDivElement>('#category-toggle-row');
const bgmToggle = document.querySelector<HTMLInputElement>('#category-toggle-bgm');
/**
 * POI SEs still read as louder than BGM even after loudness-matching individual files
 * (see sound-style-assets' NOTICE.md) and lowering every POI-category layer's own paint
 * sound-volume in the Style JSON. Rather than tuning each event-type
 * layer individually, this applies one across-the-board cut to the whole 'se' mixing category —
 * layered on top of each layer's own paint value via SoundStyleEngine's categoryGains (see
 * engine.ts), so no Style JSON content needs to change. bgm/ambient stay at 1 (their per-layer
 * paint values are the only lever for those categories).
 */
const CATEGORY_DEFAULT_VOLUME: Record<SoundCategory, number> = { bgm: 1, se: 0.5, ambient: 1 };
const lightPresetRow = document.querySelector<HTMLDivElement>('#light-preset-row');
const lightPresetSelect = document.querySelector<HTMLSelectElement>('#light-preset');
const flytoRow = document.querySelector<HTMLDivElement>('#flyto-row');
const flytoSelect = document.querySelector<HTMLSelectElement>('#flyto-city');
const flytoFlyToButton = document.querySelector<HTMLButtonElement>('#flyto-flyTo');
const flytoEaseToButton = document.querySelector<HTMLButtonElement>('#flyto-easeTo');
const flytoJumpToButton = document.querySelector<HTMLButtonElement>('#flyto-jumpTo');
const onceOnlyRow = document.querySelector<HTMLDivElement>('#once-only-row');
const onceOnlyToggle = document.querySelector<HTMLInputElement>('#once-only-toggle');
const gmtTimeRow = document.querySelector<HTMLDivElement>('#gmt-time-row');
const gmtTimeInput = document.querySelector<HTMLInputElement>('#gmt-time-input');
const gmtTimeNowButton = document.querySelector<HTMLButtonElement>('#gmt-time-now');
const weatherRainToggle = document.querySelector<HTMLInputElement>('#weather-rain-toggle');
const weatherStormToggle = document.querySelector<HTMLInputElement>('#weather-storm-toggle');
const sePoiToggle = document.querySelector<HTMLInputElement>('#se-poi-toggle');
const seTrafficToggle = document.querySelector<HTMLInputElement>('#se-traffic-toggle');
const seDaynightToggle = document.querySelector<HTMLInputElement>('#se-daynight-toggle');
const seMovetoToggle = document.querySelector<HTMLInputElement>('#se-moveto-toggle');
const nowPlayingList = document.querySelector<HTMLUListElement>('#now-playing-list');
const debugCoordsEl = document.querySelector<HTMLDivElement>('#debug-coords');
const debugTerrainEl = document.querySelector<HTMLDivElement>('#debug-terrain');
const debugCountryEl = document.querySelector<HTMLDivElement>('#debug-country');
const debugLocalTimeEl = document.querySelector<HTMLDivElement>('#debug-local-time');
const detectionLabelEl = document.querySelector<HTMLDivElement>('#detection-label');

/**
 * Estimates the local time of day from the map center's longitude and auto-selects a Light preset
 * (dawn/day/dusk/night). This is a rough approximation (rounding the UTC offset assuming
 * 15 degrees of longitude = 1 hour) that ignores real timezone boundaries (e.g. China uses a
 * single timezone for the whole country), DST, and latitude/season-dependent daylight hours — a
 * deliberate simplification to avoid extra API calls or a timezone-boundary dataset.
 */
type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

/** Approximate UTC offset (hours) from longitude (simple 15 degrees = 1 hour conversion). */
function estimateUtcOffsetHours(lng: number): number {
  return Math.round(lng / 15);
}

/** Returns the approximate "local time" at the given longitude as a 0-24 fractional hour (from the current GMT time). */
function estimateLocalHour(lng: number, now: Date = new Date()): number {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const local = utcHour + estimateUtcOffsetHours(lng);
  return ((local % 24) + 24) % 24;
}

/** Maps local hour (0-24) to a Light preset, using fixed time-of-day bands loosely modeled on sunrise/sunset. */
function presetForLocalHour(localHour: number): LightPreset {
  if (localHour >= 5 && localHour < 7) return 'dawn';
  if (localHour >= 7 && localHour < 17) return 'day';
  if (localHour >= 17 && localHour < 19) return 'dusk';
  return 'night';
}

/**
 * City list for the FlyTo (jump between cities) demo. Corresponds to the option values of
 * #flyto-city in index.html. zoom is chosen so each city roughly fits at a city-block scale.
 * Ordered west-to-east by (standard, non-DST) UTC offset; cities sharing an offset are then
 * ordered by longitude (west first), matching the <select> order.
 */
const FLYTO_CITIES: Record<string, { name: string; center: [number, number]; zoom: number }> = {
  sf: { name: 'San Francisco', center: [-122.4194, 37.7749], zoom: 12 }, // UTC-8
  dc: { name: 'Washington, D.C.', center: [-77.0369, 38.9072], zoom: 12 }, // UTC-5
  nyc: { name: 'New York', center: [-74.006, 40.7128], zoom: 12 }, // UTC-5
  saopaulo: { name: 'São Paulo', center: [-46.6333, -23.5505], zoom: 11 }, // UTC-3
  london: { name: 'London', center: [-0.1276, 51.5072], zoom: 11 }, // UTC+0
  paris: { name: 'Paris', center: [2.3522, 48.8566], zoom: 12 }, // UTC+1
  berlin: { name: 'Berlin', center: [13.405, 52.52], zoom: 12 }, // UTC+1
  helsinki: { name: 'Helsinki', center: [24.9384, 60.1699], zoom: 12 }, // UTC+2
  cairo: { name: 'Cairo', center: [31.2357, 30.0444], zoom: 11 }, // UTC+2
  minsk: { name: 'Minsk', center: [27.5615, 53.9006], zoom: 12 }, // UTC+3
  delhi: { name: 'Delhi', center: [77.1025, 28.7041], zoom: 11 }, // UTC+5:30
  beijing: { name: 'Beijing', center: [116.4074, 39.9042], zoom: 11 }, // UTC+8
  tokyo: { name: 'Tokyo', center: [139.6917, 35.6895], zoom: 11 }, // UTC+9
  sydney: { name: 'Sydney', center: [151.2093, -33.8688], zoom: 12 }, // UTC+10
};

/**
 * Max number of recently-triggered POI SEs to annotate on the map (the recent-poi-sfx source).
 * SEs without an associated POI (Light preset / FlyTo whoosh, etc.) are excluded — they have no
 * map position to annotate.
 */
const RECENT_POI_SFX_MAX = 5;

function setStatus(message: string): void {
  if (statusEl) statusEl.textContent = message;
}

/**
 * Shows/hides every control row that only makes sense once sound-style is actually audible
 * (volume, light preset, flyto, once-only, gmt time). Kept in sync with the "Disable audio" mute
 * toggle, so a muted session looks the same as a not-yet-enabled one rather than leaving every
 * control visible while nothing can be heard. #now-playing-list lives in #debug-panel (always
 * visible, like the other debug rows) rather than being gated here — it just shows the '-'
 * placeholder while nothing is playing.
 */
function setControlsVisible(visible: boolean): void {
  const flex = visible ? 'flex' : 'none';
  if (volumeRow) volumeRow.style.display = flex;
  if (categoryToggleRow) categoryToggleRow.style.display = flex;
  if (lightPresetRow) lightPresetRow.style.display = flex;
  if (flytoRow) flytoRow.style.display = flex;
  if (onceOnlyRow) onceOnlyRow.style.display = flex;
  if (gmtTimeRow) gmtTimeRow.style.display = flex;
}

function renderNowPlaying(activeLayerIds: ReadonlySet<string>): void {
  if (!nowPlayingList) return;
  nowPlayingList.innerHTML = '';
  if (activeLayerIds.size === 0) {
    const li = document.createElement('li');
    li.textContent = '-';
    nowPlayingList.appendChild(li);
    return;
  }
  for (const layerId of activeLayerIds) {
    const li = document.createElement('li');
    li.textContent = layerId;
    nowPlayingList.appendChild(li);
  }
}

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

if (!accessToken) {
  setStatus(
    'VITE_MAPBOX_ACCESS_TOKEN is not set. Create apps/examples/vanilla/.env.local and set your ' +
      "company account's Mapbox access token there (see .env.local.example).",
  );
  if (enableAudioButton) enableAudioButton.disabled = true;
} else {
  main(accessToken);
}

function main(token: string): void {
  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: 'map',
    // The Standard style has config properties (lightPreset, etc.), which the
    // lighting-condition x BGM demo needs.
    style: 'mapbox://styles/mapbox/standard',
    center: [-122.4, 37.789],
    zoom: 13,
  });

  // Kicked off immediately (independent of "Enable audio"/AudioContext) so the debug UI's
  // worldViewZoomThreshold/poiDetectionRadiusMeters/poiProximityMinzoom stop being hardcoded
  // guesses as soon as possible. Until this resolves, the module-level defaults above are used;
  // refresh the two debug displays that depend on them once the real values are known.
  void loadDebugUiThresholds().then(() => {
    updateDetectionCircleSize();
    updateAutoLightPreset();
  });

  // Before sound-style starts (no engine yet), only update the debug display; once started, also call trigger().
  let activeEngine: SoundStyleEngine | undefined;
  // Set once sound-style starts; used only to read back resolved bgm-priority-group dimension
  // values for the debug panel (see updateAreaBgmDebugDisplay) — actual BGM decisions are the
  // adapter's own responsibility, not main.ts's.
  let activeAdapter: MapboxSoundAdapter | undefined;

  /**
   * Annotates which POI most recently played an SE by highlighting it on the map (the
   * recent-poi-sfx source/layers in addDemoLayers) — a numbered ring + label per recent POI, most
   * recent largest/most opaque. To make this "the SEs that actually played during the most recent
   * proximity-detection cycle" rather than "a rolling history of the last 5", resetPoiSfx clears it
   * at the start of each cycle (called from the onProximityDetected callback below), then
   * recordPoiSfx appends only what played during that cycle.
   */
  const recentPoiSfxFeatures: Feature<Point, { rank: number; label: string }>[] = [];

  const renderRecentPoiSfxAnnotation = (): void => {
    const source = map.getSource('recent-poi-sfx') as mapboxgl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: recentPoiSfxFeatures } as FeatureCollection);
  };

  /** Called at the start of a new moveend cycle to clear the previous cycle's record. */
  const resetPoiSfx = (): void => {
    recentPoiSfxFeatures.length = 0;
    renderRecentPoiSfxAnnotation();
  };

  const recordPoiSfx = (lngLat: mapboxgl.LngLatLike, label: string): void => {
    const converted = mapboxgl.LngLat.convert(lngLat);
    recentPoiSfxFeatures.unshift({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [converted.lng, converted.lat] },
      properties: { rank: 1, label },
    });
    recentPoiSfxFeatures.length = Math.min(recentPoiSfxFeatures.length, RECENT_POI_SFX_MAX);
    recentPoiSfxFeatures.forEach((feature, index) => {
      feature.properties.rank = index + 1;
    });
    renderRecentPoiSfxAnnotation();
  };

  /**
   * The terrain/country/Light-preset/world-view BGM arbitration itself is entirely declarative Style
   * content now (a `bgm-priority-groups` entry in the Style JSON) — `MapboxSoundAdapter` resolves
   * it from the map and
   * calls engine.setActiveState() on its own, with no main.ts involvement. This function only
   * mirrors the resolved terrain/country values into the debug panel, reading them back from the
   * adapter (`getBgmPriorityDimensionValues`) rather than re-querying the map, so there's no
   * duplicate query logic between this and the SDK.
   */
  const updateAreaBgmDebugDisplay = (): void => {
    const values = activeAdapter?.getBgmPriorityDimensionValues('area-bgm-priority');
    if (debugTerrainEl) debugTerrainEl.textContent = `terrain: ${values?.terrain ?? '-'}`;
    if (debugCountryEl) debugCountryEl.textContent = `country: ${values?.country ?? '-'}`;
  };

  // Light preset can be set both manually (#light-preset) and automatically, by estimating the
  // local time from the map center's longitude (updateAutoLightPreset, recomputed on moveend). Both
  // apply through the same applyLightPreset, so a change made by one is correctly picked up by the
  // other.
  let currentLightPreset: LightPreset = (lightPresetSelect?.value as LightPreset | undefined) ?? 'day';

  // #gmt-time-input lets you manually override the "current time" in GMT, so you can try
  // dawn/dusk/etc. without waiting or moving the map. While null, the live GMT clock keeps being
  // used.
  let gmtOverrideMinutes: number | null = null;
  const getEffectiveNow = (): Date => {
    if (gmtOverrideMinutes === null) return new Date();
    const now = new Date();
    now.setUTCHours(Math.floor(gmtOverrideMinutes / 60), gmtOverrideMinutes % 60, 0, 0);
    return now;
  };
  const formatUtcHHMM = (date: Date): string =>
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;

  const applyLightPreset = (preset: LightPreset, source: 'manual' | 'auto'): void => {
    currentLightPreset = preset;
    map.setConfigProperty('basemap', 'lightPreset', preset);
    if (lightPresetSelect) lightPresetSelect.value = preset;
    if (activeEngine) {
      activeEngine.trigger(`daynight-sfx-${preset}`, { zoom: map.getZoom() });
      console.log(`[sound-style debug] daynight-sfx-${preset} (light preset, ${source})`);

      // The BGM tier (one of the area-bgm-switch-* terrain layers vs. one of its overrides) can
      // depend on the Light preset (see the Style JSON's `bgm-priority-groups`). No manual
      // re-evaluation needed here — setConfigProperty above fires a 'styledata' (dataType: 'style') event that
      // MapboxSoundAdapter's bgm-priority-group binding already listens for.
      updateAreaBgmDebugDisplay();
    }
  };

  /**
   * #weather-rain-toggle/#weather-storm-toggle each independently start/stop their own `ambient`
   * layer ('weather-rain-ambient'/'weather-storm-ambient') — both can be on at once (a rain bed and
   * a storm-wind bed are two different real recordings, not exclusive states of one clip). Neither
   * layer has a target-layer — there's no map-queryable "weather" feature, only these two
   * checkboxes — so they're driven directly by engine.updateContext()/engine.stop() rather than
   * going through MapboxSoundAdapter's target-layer/filter re-evaluation loop. Checked -> start (or
   * keep looping); unchecked -> engine.stop() (a no-op if it wasn't playing already), so only the
   * checked layers are ever actually decoding/streaming, and #now-playing-list stays an honest
   * reflection of what's audible.
   */
  const applyWeatherToggle = (layerId: string, enabled: boolean): void => {
    if (enabled) {
      activeEngine?.updateContext(layerId, { zoom: map.getZoom() });
    } else {
      activeEngine?.stop(layerId);
    }
  };

  /**
   * #se-poi-toggle mutes/unmutes every POI-related `event` layer at once — 'poi-click-sfx' plus
   * every 'poi-ping-<category>' layer (one per maki category; both click and proximity-triggered
   * playback go through the same `poi-ping-*` layers). Uses engine.setLayerEnabled()
   * (SoundStyleEngine) rather than each layer's own trigger — the layers stay bound to their
   * target-layer/proximity-trigger-group as normal, they just become a no-op while disabled. The
   * category list itself isn't hardcoded here: engine.getLayerIds() is queried live so this stays
   * correct if the Style JSON's maki category set changes.
   */
  const applyPoiToggle = (enabled: boolean): void => {
    if (!activeEngine) return;
    const poiLayerIds = activeEngine.getLayerIds().filter((id) => id === 'poi-click-sfx' || id.startsWith('poi-ping-'));
    for (const layerId of poiLayerIds) {
      activeEngine.setLayerEnabled(layerId, enabled);
    }
  };

  /** #se-traffic-toggle mutes/unmutes 'traffic-sfx' (the only traffic-related layer). */
  const applyTrafficToggle = (enabled: boolean): void => {
    activeEngine?.setLayerEnabled('traffic-sfx', enabled);
  };

  /**
   * #se-daynight-toggle mutes/unmutes the 4 Light preset switch SEs ('daynight-sfx-dawn'/'-day'/
   * '-dusk'/'-night') — the one-shot
   * chime that plays whenever #light-preset changes (manually or via updateAutoLightPreset).
   */
  const applyDaynightToggle = (enabled: boolean): void => {
    if (!activeEngine) return;
    for (const layerId of activeEngine.getLayerIds().filter((id) => id.startsWith('daynight-sfx-'))) {
      activeEngine.setLayerEnabled(layerId, enabled);
    }
  };

  /**
   * #se-moveto-toggle mutes/unmutes the 3 Move-to whoosh SEs ('flyto-whoosh'/'ease-glide'/
   * 'jump-teleport', one per flyTo/easeTo/jumpTo button) — unlike the poi-ping- / daynight-sfx-
   * families above, these 3 ids share no common prefix, so they're just listed directly.
   */
  const applyMovetoToggle = (enabled: boolean): void => {
    for (const layerId of ['flyto-whoosh', 'ease-glide', 'jump-teleport']) {
      activeEngine?.setLayerEnabled(layerId, enabled);
    }
  };

  const updateAutoLightPreset = (): void => {
    // At world view, "the local time at the map center's longitude" doesn't mean anything — every
    // timezone is on screen at once — so auto-sync is suspended entirely rather than picking
    // whichever preset the (meaningless) center-longitude happens to compute to.
    if (map.getZoom() <= worldViewZoomThreshold) {
      if (debugLocalTimeEl) debugLocalTimeEl.textContent = 'local time: - (world view)';
      return;
    }

    const effectiveNow = getEffectiveNow();
    const localHour = estimateLocalHour(map.getCenter().lng, effectiveNow);
    const preset = presetForLocalHour(localHour);

    if (debugLocalTimeEl) {
      const hh = String(Math.floor(localHour)).padStart(2, '0');
      const mm = String(Math.round((localHour % 1) * 60)).padStart(2, '0');
      const gmtLabel = gmtOverrideMinutes === null ? `GMT (live) ${formatUtcHHMM(effectiveNow)}` : `GMT (override) ${formatUtcHHMM(effectiveNow)}`;
      // Local time at the map center's Point. Estimated from GMT + longitude (see
      // estimateLocalHour; real timezone boundaries/DST are not considered). Recomputed on every
      // moveend as the map is moved.
      debugLocalTimeEl.textContent = `local time: ${hh}:${mm} (from ${gmtLabel})`;
    }
    if (preset !== currentLightPreset) {
      applyLightPreset(preset, 'auto');
    }
  };

  map.on('load', () => {
    map.setConfigProperty('basemap', 'lightPreset', lightPresetSelect?.value ?? 'day');
    addDemoLayers(map);
    updateDetectionCircleSize();
    // Once sound-style is running, the button becomes a mute toggle ("Disable audio"/"Enable
    // audio") rather than a one-shot start button — the engine/MapboxSoundAdapter/map listeners
    // set up on the first click all stay alive; "disabling" just silences the master volume rather
    // than tearing anything down (simplest way to make it safely re-enable-able, and ambient/
    // bgm-state layers keep their state so they don't have to re-evaluate from scratch).
    let audioMuted = false;
    enableAudioButton?.addEventListener('click', () => {
      if (activeEngine) {
        audioMuted = !audioMuted;
        activeEngine.setMasterVolume(audioMuted ? 0 : (volumeInput ? Number(volumeInput.value) : DEFAULT_MASTER_VOLUME));
        if (enableAudioButton) enableAudioButton.textContent = audioMuted ? 'Enable audio' : 'Disable audio';
        setControlsVisible(!audioMuted);
        return;
      }

      void startSoundStyle(map, {
        // Called at the start of every proximity-detection cycle (before dedup/cap/once-only).
        onProximityDetected: () => {
          // To make the on-map annotation "the SEs that actually played during the most recent
          // cycle" rather than "a rolling history of the last 5", clear it at the start of each
          // cycle. If a new location has no POIs at all, it's correct for it to stay empty.
          resetPoiSfx();
        },
        // AREA_BGM_PRIORITY_GROUP can re-evaluate purely from a sourcedata event (e.g. terrain/
        // country tiles finishing a late load), with no accompanying moveend — without this, the
        // #debug-terrain/#debug-country text would only ever refresh on moveend and could show a
        // stale value even though the SDK's own internal state (and the actual BGM audio) had
        // already moved on.
        onBgmPriorityUpdate: updateAreaBgmDebugDisplay,
      }).then((started) => {
        if (!started) return;
        activeEngine = started.engine;
        activeAdapter = started.adapter;
        if (enableAudioButton) enableAudioButton.textContent = 'Disable audio';
        setControlsVisible(true);
        updateAreaBgmDebugDisplay();
        updateAutoLightPreset();

        // Annotates which POI caused a click/tap/proximity SE to play (the on-map marker), reading
        // the feature MapboxSoundAdapter already passed to engine.trigger() from the emitted
        // layer:play event — instead of registering a second click listener/interaction (or, for
        // proximity, a second radius query) on the same target purely to rediscover it. Covers
        // poi-click-sfx (own GeoJSON markers, target-layer: 'poi-symbols'), every
        // poi-ping-<category> layer tapped directly (Mapbox Standard's POI featureset), and the
        // same poi-ping-<category> layers fired by the proximity-trigger-group instead
        // (distinguished via event.meta?.source — see the Style JSON's `proximity-trigger-groups`).
        started.engine.on('layer:play', (event) => {
          if (event.type !== 'layer:play') return;
          const feature = event.feature;
          const lngLat = feature && getFeatureLngLat({ geometry: feature.geometry as GeoJSONFeature['geometry'] });
          if (!lngLat) return;
          const name = typeof feature.properties.name === 'string' ? feature.properties.name : '(no name)';
          if (event.layerId === 'poi-click-sfx') {
            const category = feature.properties.category;
            if (typeof category === 'string') recordPoiSfx(lngLat, `${category} — ${name} [click]`);
          } else if (event.layerId.startsWith('poi-ping-')) {
            const category = event.layerId.slice('poi-ping-'.length);
            const suffix = event.meta?.source === 'proximity' ? 'nearby' : 'tap';
            recordPoiSfx(lngLat, `${category} — ${name} [${suffix}]`);
          }
        });

        onceOnlyToggle?.addEventListener('change', () => {
          started.adapter.setProximityOnceOnly('poi-proximity', onceOnlyToggle.checked);
        });
        lightPresetSelect?.addEventListener('change', () => {
          applyLightPreset(lightPresetSelect.value as LightPreset, 'manual');
        });

        if (weatherRainToggle) applyWeatherToggle('weather-rain-ambient', weatherRainToggle.checked);
        weatherRainToggle?.addEventListener('change', () => {
          applyWeatherToggle('weather-rain-ambient', weatherRainToggle.checked);
        });
        if (weatherStormToggle) applyWeatherToggle('weather-storm-ambient', weatherStormToggle.checked);
        weatherStormToggle?.addEventListener('change', () => {
          applyWeatherToggle('weather-storm-ambient', weatherStormToggle.checked);
        });

        if (sePoiToggle) applyPoiToggle(sePoiToggle.checked);
        sePoiToggle?.addEventListener('change', () => {
          applyPoiToggle(sePoiToggle.checked);
        });
        if (seTrafficToggle) applyTrafficToggle(seTrafficToggle.checked);
        seTrafficToggle?.addEventListener('change', () => {
          applyTrafficToggle(seTrafficToggle.checked);
        });
        if (seDaynightToggle) applyDaynightToggle(seDaynightToggle.checked);
        seDaynightToggle?.addEventListener('change', () => {
          applyDaynightToggle(seDaynightToggle.checked);
        });
        if (seMovetoToggle) applyMovetoToggle(seMovetoToggle.checked);
        seMovetoToggle?.addEventListener('change', () => {
          applyMovetoToggle(seMovetoToggle.checked);
        });

        if (gmtTimeInput) gmtTimeInput.value = formatUtcHHMM(new Date());
        gmtTimeInput?.addEventListener('input', () => {
          const parts = gmtTimeInput.value.split(':');
          const hh = Number(parts[0]);
          const mm = Number(parts[1]);
          if (Number.isNaN(hh) || Number.isNaN(mm)) return;
          gmtOverrideMinutes = hh * 60 + mm;
          updateAutoLightPreset();
        });
        gmtTimeNowButton?.addEventListener('click', () => {
          gmtOverrideMinutes = null;
          if (gmtTimeInput) gmtTimeInput.value = formatUtcHHMM(new Date());
          updateAutoLightPreset();
        });
      });
    });
  });

  // Estimates the local time from the map center's longitude and keeps Light preset auto-synced
  // (the debug display always updates; the actual switch/SE playback only happens after sound-style
  // has started).
  map.on('moveend', updateAutoLightPreset);

  const updateDebugCoords = () => {
    if (!debugCoordsEl) return;
    const center = map.getCenter();
    debugCoordsEl.textContent = `lng: ${center.lng.toFixed(5)}, lat: ${center.lat.toFixed(5)}, zoom: ${map.getZoom().toFixed(2)}`;
  };
  map.on('move', updateDebugCoords);
  updateDebugCoords();

  // The detection-radius circle is a map layer (detection-circle-fill, added in addDemoLayers) so
  // it stacks below the recent-poi-sfx annotation layers instead of always sitting on top of the
  // whole map the way an HTML overlay would. It's based on a real-world distance, so its on-screen
  // radius/position are recomputed every time from the zoom/center/latitude (unlike a fixed-px
  // circle, it has to track the map's movement) — added only once addDemoLayers has run (map
  // 'load'), so bail out until the source/layer exist.
  const updateDetectionCircleSize = () => {
    const source = map.getSource('detection-circle') as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;
    const zoom = map.getZoom();
    // Below poiProximityMinzoom, the SDK isn't running the detection query at all (see
    // POI_PROXIMITY_TRIGGER_GROUP's minzoom) — hide the circle instead of drawing a shrunk-to-a-
    // speck (or, at very low zoom, absurdly large) circle that no longer reflects real behavior.
    const visible = zoom >= poiProximityMinzoom;
    map.setLayoutProperty('detection-circle-fill', 'visibility', visible ? 'visible' : 'none');
    if (detectionLabelEl) detectionLabelEl.hidden = !visible;
    if (!visible) return;
    const center = map.getCenter();
    source.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [center.lng, center.lat] }, properties: {} });
    const diameterPixels = (2 * poiDetectionRadiusMeters) / metersPerPixelAtLat(center.lat, zoom);
    map.setPaintProperty('detection-circle-fill', 'circle-radius', diameterPixels / 2);
    if (detectionLabelEl) detectionLabelEl.style.marginTop = `${-(diameterPixels / 2 + 20)}px`;
  };
  map.on('move', updateDetectionCircleSize);
  updateDetectionCircleSize();

  // traffic-sfx is already defined in the Style JSON with 'target-layer: traffic-lines' +
  // sound-trigger: 'always'. MapboxSoundAdapter re-evaluates and fires it automatically from
  // sourcedata/moveend, so no wiring is needed on the main.ts side.

  // The actual terrain/country/Light-preset/world-view BGM switching is handled entirely by
  // MapboxSoundAdapter (see the Style JSON's `bgm-priority-groups`) — this just
  // keeps the debug panel's terrain/country display in sync with what the adapter resolved.
  map.on('moveend', updateAreaBgmDebugDisplay);
}

function addDemoLayers(map: mapboxgl.Map): void {
  // Points for the POI-click-SE demo
  map.addSource('poi', { type: 'geojson', data: poiGeoJson });
  map.addLayer({
    id: 'poi-symbols',
    type: 'circle',
    source: 'poi',
    paint: {
      'circle-radius': 8,
      'circle-color': [
        'match',
        ['get', 'category'],
        'shopping',
        '#ff7043',
        'landmark',
        '#8d6e63',
        'food',
        '#fdd835',
        'religion',
        '#7e57c2',
        'arts',
        '#ab47bc',
        'education',
        '#42a5f5',
        'park',
        '#66bb6a',
        'airport',
        '#26c6da',
        'station',
        '#ec407a',
        '#9e9e9e',
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });

  // For the traffic-ambient demo: Mapbox's real traffic tileset (mapbox-traffic-v1)
  map.addSource('mapbox-traffic', {
    type: 'vector',
    url: 'mapbox://mapbox.mapbox-traffic-v1',
  });
  map.addLayer({
    id: 'traffic-lines',
    type: 'line',
    source: 'mapbox-traffic',
    'source-layer': 'traffic',
    paint: {
      'line-width': 2,
      'line-color': [
        'match',
        ['get', 'congestion'],
        'severe',
        '#b71c1c',
        'heavy',
        '#e65100',
        'moderate',
        '#f9a825',
        'low',
        '#43a047',
        '#9e9e9e',
      ],
    },
  });

  // The POI-proximity detection-radius debug circle (see updateDetectionCircleSize) — added before
  // recent-poi-sfx-ring/-label below so it always draws underneath that annotation instead of
  // covering it.
  map.addSource('detection-circle', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
  });
  map.addLayer({
    id: 'detection-circle-fill',
    type: 'circle',
    source: 'detection-circle',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 0,
      'circle-color': 'rgba(255, 23, 68, 1)',
      'circle-opacity': 0.22,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(0, 0, 0, 0.4)',
      'circle-pitch-scale': 'map',
    },
  });

  // Highlights the last 5 POI-triggered SEs (see recordPoiSfx). Lower rank (= more recent) is
  // larger and more opaque; older ones are smaller and fainter.
  map.addSource('recent-poi-sfx', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'recent-poi-sfx-ring',
    type: 'circle',
    source: 'recent-poi-sfx',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'rank'], 1, 22, 5, 10],
      'circle-color': '#ffeb3b',
      'circle-opacity': ['interpolate', ['linear'], ['get', 'rank'], 1, 0.35, 5, 0.08],
      'circle-stroke-color': '#ffeb3b',
      'circle-stroke-width': ['interpolate', ['linear'], ['get', 'rank'], 1, 3, 5, 1],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'rank'], 1, 1, 5, 0.35],
    },
  });
  map.addLayer({
    id: 'recent-poi-sfx-label',
    type: 'symbol',
    source: 'recent-poi-sfx',
    layout: {
      'text-field': ['concat', ['get', 'rank'], ': ', ['get', 'label']],
      'text-size': 12,
      'text-offset': [0, -1.6],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#fff59d',
      'text-halo-color': '#000000',
      'text-halo-width': 1.4,
      'text-opacity': ['interpolate', ['linear'], ['get', 'rank'], 1, 1, 5, 0.4],
    },
  });
}

async function startSoundStyle(
  map: mapboxgl.Map,
  callbacks: {
    onProximityDetected: (event: { groupId: string; categories: string[] }) => void;
    onBgmPriorityUpdate: () => void;
  },
): Promise<{ engine: SoundStyleEngine; adapter: MapboxSoundAdapter } | undefined> {
  if (enableAudioButton) enableAudioButton.disabled = true;
  setStatus('Loading audio…');

  try {
    const audioContext = new AudioContext();
    await audioContext.resume();

    const engine = new SoundStyleEngine({ audioContext, baseUrl: import.meta.env.VITE_AUDIO_BASE_URL });
    const activeLayerIds = new Set<string>();

    engine.on('error', (event) => {
      if (event.type === 'error') {
        console.error(`[sound-style] ${event.layerId ?? '(global)'}: ${event.error.message}`);
      }
    });
    engine.on('layer:play', (event) => {
      if (event.type === 'layer:play') {
        activeLayerIds.add(event.layerId);
        renderNowPlaying(activeLayerIds);
      }
    });
    engine.on('layer:stop', (event) => {
      if (event.type === 'layer:stop') {
        activeLayerIds.delete(event.layerId);
        renderNowPlaying(activeLayerIds);
      }
    });

    await engine.load(await loadSoundStyle());
    engine.setMasterVolume(volumeInput ? Number(volumeInput.value) : DEFAULT_MASTER_VOLUME);
    map.addControl(new SoundAttributionControl(engine));
    // Mapbox Standard style's own internal layers can't be queried from outside the import scope,
    // so the Style JSON's `bgm-priority-groups` terrain/country dimensions rely
    // on classic-tileset hidden layers existing on the map. Rather than this app calling
    // addTerrainQueryLayers/addCountryQueryLayers itself, the adapter ensures them (idempotently —
    // a no-op if this app already had them) and tracks what it actually added so destroy() can
    // clean up only that, never a layer the app already owned.
    const adapter = new MapboxSoundAdapter(map, engine, {
      ensureTerrainQueryLayers: true,
      ensureCountryQueryLayers: true,
      onProximityDetected: callbacks.onProximityDetected,
      onBgmPriorityUpdate: callbacks.onBgmPriorityUpdate,
    });

    volumeInput?.addEventListener('input', () => {
      engine.setMasterVolume(Number(volumeInput.value));
    });

    // SE/Ambient no longer have their own mute checkbox — superseded by the per-layer POI/Traffic/
    // Rain/Storm toggles below, which is a more useful level of control than an all-or-nothing
    // category mute. Their CATEGORY_DEFAULT_VOLUME is still applied unconditionally, since 'se' at
    // 0.5 (vs. 'bgm'/'ambient' at 1) is a deliberate mixing decision independent of any UI toggle —
    // see CATEGORY_DEFAULT_VOLUME's comment.
    engine.setCategoryVolume('se', CATEGORY_DEFAULT_VOLUME.se);
    engine.setCategoryVolume('ambient', CATEGORY_DEFAULT_VOLUME.ambient);

    // BGM keeps its own category-wide mute toggle — unlike POI/traffic/rain/storm, there's no
    // single obvious "which BGM layer" to expose individually (which one is even playing depends
    // on terrain/country/Light preset), so muting the whole 'bgm' category remains the right grain
    // for this control.
    if (bgmToggle) {
      engine.setCategoryVolume('bgm', bgmToggle.checked ? CATEGORY_DEFAULT_VOLUME.bgm : 0);
      bgmToggle.addEventListener('change', () => {
        engine.setCategoryVolume('bgm', bgmToggle.checked ? CATEGORY_DEFAULT_VOLUME.bgm : 0);
      });
    }

    // Light preset (dawn/day/dusk/night) doesn't go through MapboxSoundAdapter — engine.trigger()
    // is called directly, from the same place that switches the map's Standard style config. It's
    // treated as a fixed-length one-shot SE that plays once at the moment of the switch, not a
    // continuing BGM. The wiring for manual selection (#light-preset) and auto-follow
    // (updateAutoLightPreset) is done in main() (both share applyLightPreset, so they're defined in
    // main()'s closure).
    // Move-to (jump between cities) demo. #flyto-city picks the destination; the flyTo/easeTo/
    // jumpTo buttons pick the movement method (flyTo arcs; easeTo goes straight without zooming
    // out; jumpTo is an instant jump). Each map method is called with a small `animationKind` tag
    // as its eventData — mapbox-gl-js merges that directly onto the 'movestart' event it fires
    // synchronously as part of the call, and MapboxSoundAdapter's 'movestart' trigger (see
    // flyto-whoosh/ease-glide/jump-teleport in sound-style.ts, each filtered on a different
    // animationKind) picks the right SE from that — no engine.trigger() call needed here at all.
    const moveToSelectedCity = (method: 'flyTo' | 'easeTo' | 'jumpTo'): void => {
      const city = FLYTO_CITIES[flytoSelect?.value ?? ''];
      if (!city) return;
      const cameraOptions = { center: city.center, zoom: city.zoom, essential: true };
      map[method](cameraOptions, { animationKind: method });
    };
    flytoFlyToButton?.addEventListener('click', () => moveToSelectedCity('flyTo'));
    flytoEaseToButton?.addEventListener('click', () => moveToSelectedCity('easeTo'));
    flytoJumpToButton?.addEventListener('click', () => moveToSelectedCity('jumpTo'));

    setStatus(
      'sound-style enabled: click a POI to play an SE / get near heavy traffic to raise the ambient volume / ' +
        'fly over sea, desert, forest, or an urban area to crossfade the BGM / ' +
        'a new kind of POI entering the screen center plays an SE / ' +
        'jump to a city with Fly to for a whoosh SE.',
    );
    // Re-enable the button (it started as a one-shot "Enable audio" trigger disabled during load;
    // it's now a mute toggle, so it needs to stay clickable going forward).
    if (enableAudioButton) enableAudioButton.disabled = false;
    return { engine, adapter };
  } catch (error) {
    console.error(error);
    setStatus(`Failed to start sound-style: ${error instanceof Error ? error.message : String(error)}`);
    if (enableAudioButton) enableAudioButton.disabled = false;
    return undefined;
  }
}
