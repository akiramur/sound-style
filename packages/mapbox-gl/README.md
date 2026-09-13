# @sound-style/mapbox-gl

The Mapbox GL JS binding that automatically wires [`@sound-style/core`](../core)'s `SoundStyleEngine`
into a Mapbox GL JS map. It translates click/hover/zoom events and
`queryRenderedFeatures`-based density aggregation/area detection into calls on `SoundStyleEngine`
(`trigger` / `updateContext` / `setActiveState`).

_日本語版: [README-ja.md](./README-ja.md)_

## Install

```bash
npm install @sound-style/core @sound-style/mapbox-gl mapbox-gl
```

## Usage

```ts
import mapboxgl from 'mapbox-gl';
import { SoundStyleEngine, validateSoundStyle } from '@sound-style/core';
import { MapboxSoundAdapter } from '@sound-style/mapbox-gl';

const map = new mapboxgl.Map({ container: 'map', style: '...' });

map.on('load', async () => {
  // Resume the AudioContext only from a user gesture (click, etc.) before loading sources.
  const audioContext = new AudioContext();
  await audioContext.resume();

  const engine = new SoundStyleEngine({ audioContext });
  await engine.load(validateSoundStyle(mySoundStyle));

  // Create this after engine.load() (it enumerates loaded layers to wire up events).
  const adapter = new MapboxSoundAdapter(map, engine);

  // When no longer needed:
  // adapter.destroy();
});
```

Each `sound-layer.type` is wired up as follows:

- **`event`**: if `layout['sound-trigger']` is `click`/`mouseenter`/`mouseleave`, subscribes to
  feature events on `target-layer`. If `zoom-in`/`zoom-out`, listens for `zoomend`.
- **`ambient`**: on `moveend` (and during `move` too, if `updateDuringMove: true`), runs
  `queryRenderedFeatures` on `target-layer` and passes a synthetic feature — the mean of numeric
  properties — to `updateContext()`. Without a `target-layer`, it's driven by zoom alone.
- **`bgm-state`**: on `moveend`, gets the feature on `target-layer` containing the camera center,
  and calls `setActiveState()` when the value of `layout['sound-state-property']` changes.

## Options

```ts
new MapboxSoundAdapter(map, engine, {
  // If true, runs `ambient`-type queryRenderedFeatures during 'move' too (watch the extra cost).
  updateDuringMove: false,
});
```

## Utility API

For app-specific wiring that `MapboxSoundAdapter`'s declarative auto-wiring can't cover (radius-based
detection, judgments spanning multiple layers, etc.), the following utilities are also exported:

- **`queryFeaturesWithinRadius(map, { radiusMeters, layers | target, filter?, center? })`**:
  finds features within `radiusMeters` real-world distance of the map center (or a given `center`),
  returning `{ feature, lngLat, distanceMeters }[]` sorted nearest-first.
- **`getFeatureLngLat(feature)`** / **`metersPerPixelAtLat(lat, zoom)`**: the geographic-calculation
  primitives the above uses internally; exported since they're independently useful (e.g. for
  sizing a UI overlay).
- **`addTerrainQueryLayers(map)`** / **`addCountryQueryLayers(map)`**: since Mapbox Standard's
  water/landcover/country-border data isn't exposed as a featureset, these helpers add the classic
  tileset as hidden layers as a workaround. Call timing and avoiding duplicate additions are the
  caller's responsibility. Layer IDs are exported as `TERRAIN_QUERY_LAYER_IDS` /
  `COUNTRY_QUERY_LAYER_ID`.
- **`findMatchingLayerByPrefix(engine, prefix, feature)`**: for a group of layers named
  `<prefix><category>` (e.g. `poi-ping-<category>`), determines which layer's `filter` matches
  `feature` and returns that layer ID with the `prefix` stripped. Used to keep the
  class/group-taxonomy-to-category mapping in one place (the sound-style JSON's `filter`) instead
  of duplicating it in application code.
