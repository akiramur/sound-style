import mapboxgl from 'mapbox-gl';
import type { GeoJSONFeature } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { SoundStyleEngine, validateSoundStyle, type SoundStyleSpecification } from '@sound-style/core';
import { getFeatureLngLat, MapboxSoundAdapter, SoundAttributionControl } from '@sound-style/mapbox-gl';
import { poiGeoJson } from './poi-data.js';
import { createGhostElement, isHalloweenCategory, type HalloweenCategory } from './ghosts.js';
import { MAKI_TO_HALLOWEEN_CATEGORY } from './maki-map.js';

/**
 * This app only ever loads a compiled sound-style.json artifact at runtime — the same way any
 * user bringing their own Style would — rather than authoring the Style inline in application
 * code.
 */
async function loadSoundStyle(): Promise<SoundStyleSpecification> {
  const response = await fetch(`${import.meta.env.BASE_URL}styles/sound-style-halloween.json`);
  return validateSoundStyle(await response.json());
}

// Fallback for when #master-volume isn't found in the DOM — kept in sync with its `value`
// attribute in index.html.
const DEFAULT_MASTER_VOLUME = 0.6;

// Covers San Francisco and its surrounding bay-area shoreline, so "roam SF" wanders across the
// whole city/region rather than just the small haunted POI cluster in poi-data.ts.
const ROAM_BOUNDS = { minLng: -122.51, maxLng: -122.28, minLat: 37.63, maxLat: 37.83 } as const;
const ROAM_ZOOM = 18;
// A fast, car-like pace. Movement is plain straight-line lng/lat interpolation toward a randomly
// chosen point in ROAM_BOUNDS (ignores roads entirely, as requested) — once within
// ROAM_ARRIVE_THRESHOLD_M of it, a new random target is picked, so the camera just keeps gliding
// from one to the next indefinitely instead of ever coming to rest.
const ROAM_SPEED_MPS = 60;
const ROAM_ARRIVE_THRESHOLD_M = 15;
// A new random target (i.e. a new heading) is picked at least this often, even if the camera
// hasn't reached the current one yet, so roaming doesn't just drift in one direction for a while.
const ROAM_DIRECTION_CHANGE_INTERVAL_MS = 5_000;
const METERS_PER_DEGREE_LAT = 111_320;

function metersPerDegreeLng(atLat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((atLat * Math.PI) / 180);
}

/** Planar approximation — fine at city-block scale, not meant for long distances. */
function distanceMeters(from: [number, number], to: [number, number]): number {
  const dLng = (to[0] - from[0]) * metersPerDegreeLng((from[1] + to[1]) / 2);
  const dLat = (to[1] - from[1]) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dLng, dLat);
}

const statusEl = document.querySelector<HTMLParagraphElement>('#status');
const enableAudioButton = document.querySelector<HTMLButtonElement>('#enable-audio');
const roamButton = document.querySelector<HTMLButtonElement>('#roam-sf');
const volumeRow = document.querySelector<HTMLDivElement>('#volume-row');
const volumeInput = document.querySelector<HTMLInputElement>('#master-volume');
const nowPlayingList = document.querySelector<HTMLUListElement>('#now-playing-list');
const debugCoordsEl = document.querySelector<HTMLDivElement>('#debug-coords');
const debugPanelEl = document.querySelector<HTMLDivElement>('#debug-panel');
const infoToggle = document.querySelector<HTMLInputElement>('#info-toggle');

infoToggle?.addEventListener('change', () => {
  if (debugPanelEl) debugPanelEl.style.display = infoToggle.checked ? 'flex' : 'none';
});

function setStatus(message: string): void {
  if (statusEl) statusEl.textContent = message;
}

/** Shows/hides every control row that only makes sense once sound-style is actually audible. */
function setControlsVisible(visible: boolean): void {
  const flex = visible ? 'flex' : 'none';
  if (volumeRow) volumeRow.style.display = flex;
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
    'VITE_MAPBOX_ACCESS_TOKEN is not set. Create apps/examples/halloween/.env.local and set your ' +
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
    style: 'mapbox://styles/murao/cmu585mi1002i01sq8exe12a8', // "Halloween Night" custom style
    center: [-122.406, 37.789],
    zoom: 14,
    // "Roam SF" (below) repeatedly crosses back and forth over the same small area at speed —
    // the default cache is sized for normal pan/zoom, not that, and evicting/re-fetching tiles
    // that fast was causing brief rendering hitches (Mapbox GL internally erroring on a symbol
    // placement pass referencing an already-evicted tile mid-frame). A larger cache just keeps
    // those tiles around instead.
    maxTileCacheSize: 200,
  });

  /**
   * Ghosts (see src/ghosts.ts) are rendered via mapboxgl.Marker rather than a GL circle/symbol
   * layer — a deliberate divergence from this repo's usual map-layer-only annotation pattern,
   * chosen so the fade-in/float/fade-out lifecycle can be driven by plain CSS transitions/
   * keyframes. Keyed by POI name so re-triggering the same POI reuses its marker instead of
   * stacking duplicates, and each ghost's visible lifetime is tied directly to its real
   * 'layer:play' -> 'layer:stop' window rather than a guessed fixed duration.
   */
  // `ghost` is the element createGhostElement's CSS classes/transitions actually apply to — kept
  // separately from the marker because mapboxgl.Marker writes its own inline positioning
  // `transform` onto whatever element it's given (`marker`'s root), which would otherwise clobber
  // our CSS `transform` rules if they lived on the same element (see createGhostElement's doc
  // comment in ghosts.ts). `syncElements` is every element whose classes must mirror `ghost`'s —
  // currently always just `[ghost]`, kept as a list so a future multi-element effect (a trailing
  // afterimage or similar) could plug back in here without touching this lifecycle code again.
  const ghostMarkers = new Map<string, { marker: mapboxgl.Marker; ghost: HTMLElement; syncElements: HTMLElement[] }>();
  const ghostLeaveHandlers = new Map<string, () => void>();
  // witch-shop only (see the `.ghost--witch-shop.ghost-fading` rule in index.html — inert for
  // every other category, no CSS targets that class there): once she's fully sharp (her `filter`
  // transition to blur(0) takes 1.2s — see index.html), she starts fading to transparent on her
  // own instead of just sitting at a constant opacity until the real SE-driven 'ghost-leaving'
  // eventually arrives (a fixed ~2s clip, so 1.2s leaves real time for this to actually play
  // before that takes over). Timed via a plain setTimeout + a 3rd class (not a CSS @keyframes
  // animation): an animation with fill-mode:forwards holding the opacity, then swapped for
  // 'ghost-leaving' mid-flight, previously failed to hand off into a transition smoothly (opacity
  // would jump instead of easing) — see the git history for that dead end. A timer that just adds
  // one more plain-transition class avoids the whole animation/transition handoff problem.
  const WITCH_FADE_DELAY_MS = 1200;
  const ghostFadeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Every category except witch-shop (which has its own self-FADE via ghostFadeTimers above) has
  // no "stay active while still visible" phase of its own — it should just leave outright, almost
  // immediately after its own entrance finishes, instead of sitting at full opacity for however
  // long the real click/proximity SE happens to run before the SDK's 'layer:stop' naturally calls
  // hideGhost. Shortening a category's *leaving* transition (see index.html) only makes the exit
  // itself quicker — it does nothing about this hold time, which is what actually reads as "stays
  // a while before fading out". So each of these gets its own timer that calls hideGhost directly,
  // shortly after its own entrance transition would have finished (monument's is a quick 0.12s
  // opacity-only fade — see .ghost--monument in index.html — everyone else uses the base
  // .ghost.ghost-visible's 1.3s), well before the real SE is likely to end.
  const SELF_HIDE_DELAY_MS: Partial<Record<HalloweenCategory, number>> = {
    monument: 900,
    cemetery: 1400,
    'haunted-mansion': 1400,
    church: 1400,
    'info-booth': 1400,
  };
  const ghostSelfHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const showGhost = (category: HalloweenCategory, lngLat: [number, number], key: string): void => {
    let entry = ghostMarkers.get(key);
    if (!entry) {
      const { root, ghost, syncElements, anchor } = createGhostElement(category);
      const marker = new mapboxgl.Marker({ element: root, anchor }).setLngLat(lngLat).addTo(map);
      entry = { marker, ghost, syncElements };
      ghostMarkers.set(key, entry);
    } else {
      entry.marker.setLngLat(lngLat);
    }
    const { ghost: el, syncElements } = entry;
    const pendingLeave = ghostLeaveHandlers.get(key);
    if (pendingLeave) {
      el.removeEventListener('transitionend', pendingLeave);
      ghostLeaveHandlers.delete(key);
    }
    const pendingFade = ghostFadeTimers.get(key);
    if (pendingFade) {
      clearTimeout(pendingFade);
      ghostFadeTimers.delete(key);
    }
    const pendingSelfHide = ghostSelfHideTimers.get(key);
    if (pendingSelfHide) {
      clearTimeout(pendingSelfHide);
      ghostSelfHideTimers.delete(key);
    }
    for (const sync of syncElements) sync.classList.remove('ghost-leaving', 'ghost-fading');
    // Force a reflow before adding the visible class so the entrance transition always plays,
    // even for a marker whose element already existed (re-triggered before it fully left).
    void el.offsetHeight;
    for (const sync of syncElements) sync.classList.add('ghost-visible');
    if (category === 'witch-shop') {
      ghostFadeTimers.set(
        key,
        setTimeout(() => {
          ghostFadeTimers.delete(key);
          // Skip if she's already left/been re-triggered by the time this fires.
          if (!el.classList.contains('ghost-visible')) return;
          for (const sync of syncElements) sync.classList.add('ghost-fading');
        }, WITCH_FADE_DELAY_MS),
      );
    }
    const selfHideDelay = SELF_HIDE_DELAY_MS[category];
    if (selfHideDelay !== undefined) {
      ghostSelfHideTimers.set(
        key,
        setTimeout(() => {
          ghostSelfHideTimers.delete(key);
          // Skip if it's already left/been re-triggered by the time this fires.
          if (!el.classList.contains('ghost-visible')) return;
          hideGhost(key);
        }, selfHideDelay),
      );
    }
  };

  const hideGhost = (key: string): void => {
    const entry = ghostMarkers.get(key);
    if (!entry) return;
    const { marker, ghost: el, syncElements } = entry;
    const pendingFade = ghostFadeTimers.get(key);
    if (pendingFade) {
      clearTimeout(pendingFade);
      ghostFadeTimers.delete(key);
    }
    const pendingSelfHide = ghostSelfHideTimers.get(key);
    if (pendingSelfHide) {
      clearTimeout(pendingSelfHide);
      ghostSelfHideTimers.delete(key);
    }
    for (const sync of syncElements) sync.classList.remove('ghost-visible', 'ghost-fading');
    void el.offsetHeight;
    for (const sync of syncElements) sync.classList.add('ghost-leaving');
    const onTransitionEnd = (): void => {
      marker.remove();
      ghostMarkers.delete(key);
      ghostLeaveHandlers.delete(key);
    };
    ghostLeaveHandlers.set(key, onTransitionEnd);
    el.addEventListener('transitionend', onTransitionEnd, { once: true });
  };

  // Both our own fictional POIs (poi-data.ts) and real Mapbox Standard POIs fire through the same
  // 'halloween-ping-' prefix/proximity group (see sound-style-halloween.json), matching vanilla's
  // single poi-proximity group so max-per-tick/max-concurrent/category-cooldown-ms apply across
  // both kinds of POI together, not as two independent caps.
  const PING_PREFIX = 'halloween-ping-';
  // A `maki` id (e.g. "castle") is a layer suffix directly, EXCEPT for the 2 maki values that
  // collide with one of our own 6 category names ("cemetery", "monument") -- those real-POI
  // layers are named `real-<maki>` to keep every sound-layer id unique (see the style JSON).
  const REAL_POI_SUFFIX_PREFIX = 'real-';

  const ghostKeyAndCategoryFor = (
    feature: { properties: Record<string, unknown>; geometry?: unknown } | undefined,
    layerId: string,
  ): { key: string; category: HalloweenCategory; lngLat: [number, number] } | undefined => {
    if (!layerId.startsWith(PING_PREFIX)) return undefined;
    const suffix = layerId.slice(PING_PREFIX.length);
    const category = isHalloweenCategory(suffix)
      ? suffix
      : MAKI_TO_HALLOWEEN_CATEGORY[suffix.startsWith(REAL_POI_SUFFIX_PREFIX) ? suffix.slice(REAL_POI_SUFFIX_PREFIX.length) : suffix];
    if (!category) return undefined;
    const lngLat = feature && getFeatureLngLat({ geometry: feature.geometry as GeoJSONFeature['geometry'] });
    if (!lngLat) return undefined;
    const name = typeof feature?.properties.name === 'string' ? feature.properties.name : `${lngLat[0]},${lngLat[1]}`;
    return { key: name, category, lngLat };
  };

  let activeEngine: SoundStyleEngine | undefined;

  map.on('load', () => {
    map.setConfigProperty('basemap', 'lightPreset', 'night');
    addDemoLayers(map);

    let audioMuted = false;
    enableAudioButton?.addEventListener('click', () => {
      if (activeEngine) {
        audioMuted = !audioMuted;
        activeEngine.setEnabled(!audioMuted);
        if (enableAudioButton) enableAudioButton.textContent = audioMuted ? 'Enable audio' : 'Disable audio';
        setControlsVisible(!audioMuted);
        return;
      }

      void startSoundStyle(map).then((started) => {
        if (!started) return;
        activeEngine = started.engine;
        if (enableAudioButton) enableAudioButton.textContent = 'Disable audio';
        setControlsVisible(true);

        started.engine.on('layer:play', (event) => {
          if (event.type !== 'layer:play') return;
          const resolved = ghostKeyAndCategoryFor(event.feature, event.layerId);
          if (resolved) showGhost(resolved.category, resolved.lngLat, resolved.key);
        });
        started.engine.on('layer:stop', (event) => {
          if (event.type !== 'layer:stop') return;
          const resolved = ghostKeyAndCategoryFor(event.feature, event.layerId);
          if (resolved) hideGhost(resolved.key);
        });

        // The eerie ambient bed is now terrain-driven (halloween-area-bgm-priority in
        // sound-style-halloween.json — urban vs. sea/desert/forest/world-view, mirroring the
        // vanilla example's AREA_BGM_PRIORITY_GROUP) — MapboxSoundAdapter resolves and starts it
        // on its own from the map's terrain/zoom, no manual trigger needed here anymore.
      });
    });
  });

  const randomPointInBounds = (): [number, number] => [
    ROAM_BOUNDS.minLng + Math.random() * (ROAM_BOUNDS.maxLng - ROAM_BOUNDS.minLng),
    ROAM_BOUNDS.minLat + Math.random() * (ROAM_BOUNDS.maxLat - ROAM_BOUNDS.minLat),
  ];

  let roamFrame: number | undefined;
  let roamTarget: [number, number] | undefined;
  let roamLastTimestamp: number | undefined;
  // Forces a fresh random target — i.e. a new direction — every ROAM_DIRECTION_CHANGE_INTERVAL_MS,
  // not just whenever the camera happens to arrive at the current one.
  let roamLastDirectionChangeTimestamp: number | undefined;

  const stepRoam = (timestamp: number): void => {
    // Capped at 0.25s: a backgrounded/throttled tab can leave a huge gap between rAF callbacks,
    // and an uncapped dt here would otherwise be indistinguishable from "just teleport" (t clamps
    // to 1 in the interpolation below either way, so this only matters for very large gaps, but
    // there's no reason to let a multi-second dt flow through untouched).
    const dt = roamLastTimestamp === undefined ? 0 : Math.min(0.25, (timestamp - roamLastTimestamp) / 1000);
    roamLastTimestamp = timestamp;

    const center = map.getCenter();
    const current: [number, number] = [center.lng, center.lat];
    const dueForDirectionChange =
      roamLastDirectionChangeTimestamp === undefined ||
      timestamp - roamLastDirectionChangeTimestamp >= ROAM_DIRECTION_CHANGE_INTERVAL_MS;
    if (!roamTarget || dueForDirectionChange || distanceMeters(current, roamTarget) < ROAM_ARRIVE_THRESHOLD_M) {
      roamTarget = randomPointInBounds();
      roamLastDirectionChangeTimestamp = timestamp;
    }

    const distToTarget = distanceMeters(current, roamTarget);
    const t = Math.min(1, (ROAM_SPEED_MPS * dt) / Math.max(distToTarget, 0.0001));
    const nextCenter: [number, number] = [
      current[0] + (roamTarget[0] - current[0]) * t,
      current[1] + (roamTarget[1] - current[1]) * t,
    ];

    // Bearing is deliberately left untouched (always north-up) — rotating the camera forces
    // Mapbox GL to redo symbol collision/placement for the whole viewport on every change, which
    // at this speed caused visible hitches right after each turn.
    map.jumpTo({ center: nextCenter, zoom: ROAM_ZOOM });

    roamFrame = requestAnimationFrame(stepRoam);
  };

  roamButton?.addEventListener('click', () => {
    if (roamFrame !== undefined) {
      cancelAnimationFrame(roamFrame);
      roamFrame = undefined;
      roamTarget = undefined;
      roamLastTimestamp = undefined;
      roamLastDirectionChangeTimestamp = undefined;
      roamButton.textContent = 'Roam SF';
      return;
    }
    roamButton.textContent = 'Stop roaming';
    roamFrame = requestAnimationFrame(stepRoam);
  });

  const updateDebugCoords = () => {
    if (!debugCoordsEl) return;
    const center = map.getCenter();
    debugCoordsEl.textContent = `lng: ${center.lng.toFixed(5)}, lat: ${center.lat.toFixed(5)}, zoom: ${map.getZoom().toFixed(2)}`;
  };
  map.on('move', updateDebugCoords);
  updateDebugCoords();
}

const CATEGORY_COLORS: Record<HalloweenCategory, string> = {
  cemetery: '#8f97a3',
  'haunted-mansion': '#9c5cca',
  'witch-shop': '#5cb85c',
  church: '#e0c060',
  monument: '#a68355',
  'info-booth': '#3cb4be',
};

function addDemoLayers(map: mapboxgl.Map): void {
  // No POI-detection-radius debug circle here (unlike the vanilla example) — this demo is about
  // the ghost annotation, not the detection mechanics.
  map.addSource('halloween-poi', { type: 'geojson', data: poiGeoJson });
  map.addLayer({
    id: 'halloween-poi-symbols',
    type: 'circle',
    source: 'halloween-poi',
    paint: {
      'circle-radius': 7,
      'circle-color': [
        'match',
        ['get', 'category'],
        'cemetery',
        CATEGORY_COLORS.cemetery,
        'haunted-mansion',
        CATEGORY_COLORS['haunted-mansion'],
        'witch-shop',
        CATEGORY_COLORS['witch-shop'],
        'church',
        CATEGORY_COLORS.church,
        'monument',
        CATEGORY_COLORS.monument,
        'info-booth',
        CATEGORY_COLORS['info-booth'],
        '#9e9e9e',
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1a0f22',
    },
  });
}

async function startSoundStyle(map: mapboxgl.Map): Promise<{ engine: SoundStyleEngine; adapter: MapboxSoundAdapter } | undefined> {
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

    // ensureTerrainQueryLayers is needed for halloween-area-bgm-priority's terrain dimension
    // (sea/desert/forest/urban) to resolve — see sound-style-halloween.json. No country dimension
    // is used here (unlike the vanilla example's AREA_BGM_PRIORITY_GROUP), so
    // ensureCountryQueryLayers isn't needed.
    const adapter = new MapboxSoundAdapter(map, engine, { ensureTerrainQueryLayers: true });
    // The shared Style (sound-style-halloween.json) sets once-only: true for this group, but this
    // demo always wants repeat triggers on revisit — no UI toggle for it, just force it off here.
    adapter.setProximityOnceOnly('halloween-proximity', false);

    volumeInput?.addEventListener('input', () => {
      engine.setMasterVolume(Number(volumeInput.value));
    });

    setStatus(
      'sound-style enabled: click a haunted POI (or get close to one) to summon its ghost — ' +
        'each kind of place has its own look.',
    );
    if (enableAudioButton) enableAudioButton.disabled = false;
    return { engine, adapter };
  } catch (error) {
    console.error(error);
    setStatus(`Failed to start sound-style: ${error instanceof Error ? error.message : String(error)}`);
    if (enableAudioButton) enableAudioButton.disabled = false;
    return undefined;
  }
}
