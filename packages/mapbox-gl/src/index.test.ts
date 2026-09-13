import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  BgmPriorityGroup,
  ProximityTriggerGroup,
  SoundLayerSpecification,
  SoundStyleEngine,
} from '@sound-style/core';
import {
  addCountryQueryLayers,
  addTerrainQueryLayers,
  findMatchingLayerByPrefix,
  getFeatureLngLat,
  MapboxSoundAdapter,
  metersPerPixelAtLat,
  queryFeaturesWithinRadius,
} from './index.js';

type EventHandler = (event?: unknown) => void;

function createFakeMap() {
  const listeners = new Map<string, EventHandler[]>();
  let zoom = 10;

  function keyOf(type: string, layerIdOrHandler: unknown): string {
    return typeof layerIdOrHandler === 'string' ? `${type}:${layerIdOrHandler}` : type;
  }

  const on = vi.fn((type: string, a: unknown, b?: EventHandler) => {
    const key = keyOf(type, a);
    const handler = (b ?? a) as EventHandler;
    const list = listeners.get(key) ?? [];
    list.push(handler);
    listeners.set(key, list);
  });

  const off = vi.fn((type: string, a: unknown, b?: EventHandler) => {
    const key = keyOf(type, a);
    const handler = (b ?? a) as EventHandler;
    const list = listeners.get(key);
    if (list) {
      listeners.set(
        key,
        list.filter((h) => h !== handler),
      );
    }
  });

  const queryRenderedFeatures = vi.fn().mockReturnValue([]);
  const interactions = new Map<string, { handler: (event: unknown) => void }>();
  const configProperties = new Map<string, unknown>();
  const layerIds = new Set<string>();
  const sourceIds = new Set<string>();

  const addInteraction = vi.fn((id: string, interaction: { handler: (event: unknown) => void }) => {
    interactions.set(id, interaction);
  });
  const removeInteraction = vi.fn((id: string) => {
    interactions.delete(id);
  });
  const getLayer = vi.fn((id: string): { id?: string; source?: string } | undefined =>
    layerIds.has(id) ? { id } : undefined,
  );
  const getSource = vi.fn((id: string) => (sourceIds.has(id) ? { id } : undefined));
  const addLayer = vi.fn((layer: { id: string }) => {
    layerIds.add(layer.id);
  });
  const addSource = vi.fn((id: string) => {
    sourceIds.add(id);
  });
  const removeLayer = vi.fn((id: string) => {
    layerIds.delete(id);
  });
  const removeSource = vi.fn((id: string) => {
    sourceIds.delete(id);
  });

  const map = {
    on,
    off,
    getZoom: () => zoom,
    getCenter: () => ({ lng: 0, lat: 0 }),
    project: vi.fn().mockReturnValue({ x: 0, y: 0 }),
    queryRenderedFeatures,
    addInteraction,
    removeInteraction,
    getLayer,
    getSource,
    addLayer,
    addSource,
    removeLayer,
    removeSource,
    getConfigProperty: (scope: string, property: string) => configProperties.get(`${scope}:${property}`),
  };

  return {
    map: map as unknown as MapboxMap,
    setZoom: (z: number) => {
      zoom = z;
    },
    setConfigProperty: (scope: string, property: string, value: unknown) => {
      configProperties.set(`${scope}:${property}`, value);
    },
    /** Pre-seed a layer id as if the app had already added it, before constructing the adapter. */
    presetLayer: (id: string) => {
      layerIds.add(id);
    },
    fire: (key: string, event?: unknown) => {
      for (const handler of listeners.get(key) ?? []) {
        handler(event);
      }
    },
    fireInteraction: (id: string, event?: unknown) => interactions.get(id)?.handler(event),
    getLayer,
    getSource,
    addLayer,
    addSource,
    removeLayer,
    removeSource,
    queryRenderedFeatures,
    addInteraction,
    removeInteraction,
  };
}

function createFakeEngine(
  layers: SoundLayerSpecification[],
  bgmPriorityGroups: BgmPriorityGroup[] = [],
  proximityTriggerGroups: ProximityTriggerGroup[] = [],
) {
  const layerMap = new Map(layers.map((layer) => [layer.id, layer]));
  const eventListeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    getLayerIds: () => Array.from(layerMap.keys()),
    getLayer: (id: string) => layerMap.get(id),
    getBgmPriorityGroups: () => bgmPriorityGroups,
    getProximityTriggerGroups: () => proximityTriggerGroups,
    trigger: vi.fn(),
    updateContext: vi.fn(),
    setActiveState: vi.fn(),
    on: (type: string, handler: (event: unknown) => void) => {
      let set = eventListeners.get(type);
      if (!set) {
        set = new Set();
        eventListeners.set(type, set);
      }
      set.add(handler);
    },
    off: (type: string, handler: (event: unknown) => void) => {
      eventListeners.get(type)?.delete(handler);
    },
    /** Test-only helper: simulates the engine emitting layer:play/layer:stop (see max-concurrent tests). */
    emit: (event: { type: string; layerId: string }) => {
      for (const handler of eventListeners.get(event.type) ?? []) handler(event);
    },
  };
}

describe('MapboxSoundAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('event layers', () => {
    const layer: SoundLayerSpecification = {
      id: 'poi-click-sfx',
      type: 'event',
      source: 'poi-sfx',
      'sound-clip': 'select',
      'target-layer': 'poi-symbols',
      layout: { 'sound-trigger': 'click' },
    };

    it('forwards a click on the target layer to engine.trigger()', () => {
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      fakeMap.fire('click:poi-symbols', {
        features: [{ id: 'f1', properties: { kind: 'cafe' } }],
      });

      expect(engine.trigger).toHaveBeenCalledWith('poi-click-sfx', {
        zoom: 10,
        feature: { id: 'f1', properties: { kind: 'cafe' } },
      });
    });

    it("passes the clicked feature's geometry through to engine.trigger(), for apps that want to annotate where a sound fired", () => {
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      const geometry = { type: 'Point', coordinates: [10, 20] };

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      fakeMap.fire('click:poi-symbols', {
        features: [{ id: 'f1', properties: { kind: 'cafe' }, geometry }],
      });

      expect(engine.trigger).toHaveBeenCalledWith('poi-click-sfx', {
        zoom: 10,
        feature: { id: 'f1', properties: { kind: 'cafe' }, geometry },
      });
    });

    it('does not trigger when the feature does not match layer.filter', () => {
      const filteredLayer: SoundLayerSpecification = {
        ...layer,
        filter: ['==', ['get', 'kind'], 'restaurant'],
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([filteredLayer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      fakeMap.fire('click:poi-symbols', {
        features: [{ id: 'f1', properties: { kind: 'cafe' } }],
      });
      expect(engine.trigger).not.toHaveBeenCalled();

      fakeMap.fire('click:poi-symbols', {
        features: [{ id: 'f2', properties: { kind: 'restaurant' } }],
      });
      expect(engine.trigger).toHaveBeenCalledWith(
        'poi-click-sfx',
        expect.objectContaining({ feature: { id: 'f2', properties: { kind: 'restaurant' } } }),
      );
    });

    it('debounces repeated triggers for the same feature within sound-debounce', () => {
      const debouncedLayer: SoundLayerSpecification = {
        ...layer,
        layout: { 'sound-trigger': 'click', 'sound-debounce': 1000 },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([debouncedLayer]);
      vi.spyOn(Date, 'now').mockReturnValue(0);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      const event = { features: [{ id: 'f1', properties: {} }] };
      fakeMap.fire('click:poi-symbols', event);
      fakeMap.fire('click:poi-symbols', event);

      expect(engine.trigger).toHaveBeenCalledTimes(1);
    });

    it('fires on zoomend when zoom increases for a zoom-in trigger', () => {
      const zoomLayer: SoundLayerSpecification = {
        ...layer,
        layout: { 'sound-trigger': 'zoom-in' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([zoomLayer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      fakeMap.setZoom(12);
      fakeMap.fire('zoomend');
      expect(engine.trigger).toHaveBeenCalledTimes(1);

      fakeMap.setZoom(8);
      fakeMap.fire('zoomend');
      expect(engine.trigger).toHaveBeenCalledTimes(1);
    });

    it('fires on movestart with no target-layer/target-featureset needed, reading eventData via filter', () => {
      const flyToLayer: SoundLayerSpecification = {
        id: 'flyto-whoosh',
        type: 'event',
        source: 'flyto-sfx',
        filter: ['==', ['get', 'animationKind'], 'flyTo'],
        layout: { 'sound-trigger': 'movestart' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([flyToLayer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      // mapbox-gl-js merges a transition's eventData (map.flyTo(options, eventData)) directly onto
      // the fired 'movestart' event object.
      fakeMap.fire('movestart', { animationKind: 'jumpTo' });
      expect(engine.trigger).not.toHaveBeenCalled();

      fakeMap.fire('movestart', { animationKind: 'flyTo' });
      expect(engine.trigger).toHaveBeenCalledTimes(1);
      expect(engine.trigger).toHaveBeenCalledWith('flyto-whoosh', {
        zoom: 10,
        feature: { properties: { animationKind: 'flyTo' } },
      });
    });

    it('unbinds the movestart listener on destroy()', () => {
      const layerNoTarget: SoundLayerSpecification = {
        id: 'jump-teleport',
        type: 'event',
        source: 'jump-teleport-sfx',
        layout: { 'sound-trigger': 'movestart' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layerNoTarget]);

      const adapter = new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      adapter.destroy();
      fakeMap.fire('movestart', { animationKind: 'jumpTo' });

      expect(engine.trigger).not.toHaveBeenCalled();
    });

    it('forwards a click on a target-featureset to engine.trigger() via addInteraction', () => {
      const featuresetLayer: SoundLayerSpecification = {
        id: 'poi-click-sfx',
        type: 'event',
        source: 'poi-sfx',
        'sound-clip': 'select',
        'target-featureset': { featuresetId: 'poi', importId: 'basemap' },
        layout: { 'sound-trigger': 'click' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([featuresetLayer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(fakeMap.addInteraction).toHaveBeenCalledWith(
        'sound-style:poi-click-sfx',
        expect.objectContaining({
          type: 'click',
          target: { featuresetId: 'poi', importId: 'basemap' },
        }),
      );

      const result = fakeMap.fireInteraction('sound-style:poi-click-sfx', {
        feature: { id: 'f1', properties: { kind: 'cafe' } },
      });

      expect(engine.trigger).toHaveBeenCalledWith('poi-click-sfx', {
        zoom: 10,
        feature: { id: 'f1', properties: { kind: 'cafe' } },
      });
      // The mapbox-gl-js Interactions API treats any non-false return value as consuming the
      // event, which stops propagation to other interactions registered on the same target
      // (other layers, or another interaction from the host app). We must always return false
      // so multiple sound-style layers and host-app interactions can share the same
      // target-featureset.
      expect(result).toBe(false);
    });

    it('fires for the top matching feature on bind, and again on sourcedata only if it changed', () => {
      const alwaysLayer: SoundLayerSpecification = {
        id: 'traffic-sfx',
        type: 'event',
        source: 'traffic-sfx',
        'target-layer': 'traffic-lines',
        layout: { 'sound-trigger': 'always' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([alwaysLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ id: 'f1', properties: { congestion: 'severe' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.trigger).toHaveBeenCalledTimes(1);
      expect(engine.trigger).toHaveBeenLastCalledWith('traffic-sfx', {
        zoom: 10,
        feature: { id: 'f1', properties: { congestion: 'severe' } },
      });

      // Regression test (2026-09-12): a sourcedata event that only re-finds the same feature
      // (id: 'f1') must not re-fire (previously this fired every time — causing it to keep
      // firing on every tile update while the same congestion stayed in view).
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).toHaveBeenCalledTimes(1);

      // Switching to a different feature (id: 'f2') fires again.
      fakeMap.queryRenderedFeatures.mockReturnValue([{ id: 'f2', properties: { congestion: 'heavy' } }]);
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).toHaveBeenCalledTimes(2);
      expect(engine.trigger).toHaveBeenLastCalledWith('traffic-sfx', {
        zoom: 10,
        feature: { id: 'f2', properties: { congestion: 'heavy' } },
      });

      // Once the congestion clears and the same 'f1' reappears, it fires again (state was reset).
      fakeMap.queryRenderedFeatures.mockReturnValue([]);
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).toHaveBeenCalledTimes(2);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ id: 'f1', properties: { congestion: 'severe' } }]);
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).toHaveBeenCalledTimes(3);
    });

    // Regression test: found on a real device on 2026-09-12 — when target-layer has zero
    // matching features, fire() itself must not be called. Previously, even when
    // queryRenderedFeatures() returned an empty array, we still called fire(undefined), so
    // traffic-sfx (filtered on congestion in [moderate,heavy,severe]) would fire on every
    // sourcedata re-evaluation even with zero congestion features.
    it('does not fire an always-trigger layer when no feature is found', () => {
      const alwaysLayer: SoundLayerSpecification = {
        id: 'traffic-sfx',
        type: 'event',
        source: 'traffic-sfx',
        'target-layer': 'traffic-lines',
        filter: ['in', ['get', 'congestion'], ['literal', ['moderate', 'heavy', 'severe']]],
        layout: { 'sound-trigger': 'always' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([alwaysLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.trigger).not.toHaveBeenCalled();

      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).not.toHaveBeenCalled();
    });

    it('skips the query (and never fires) for an always-trigger layer while zoom is below minzoom', () => {
      // e.g. mapbox.mapbox-traffic-v1 itself has minzoom: 6 — below that, no traffic tiles exist
      // at all, so there's no point querying (and no point firing) every moveend/move.
      const alwaysLayer: SoundLayerSpecification = {
        id: 'traffic-sfx',
        type: 'event',
        source: 'traffic-sfx',
        'target-layer': 'traffic-lines',
        minzoom: 6,
        layout: { 'sound-trigger': 'always' },
      };
      const fakeMap = createFakeMap();
      fakeMap.setZoom(4);
      const engine = createFakeEngine([alwaysLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ id: 'f1', properties: { congestion: 'severe' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(fakeMap.queryRenderedFeatures).not.toHaveBeenCalled();
      expect(engine.trigger).not.toHaveBeenCalled();

      fakeMap.setZoom(8);
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.trigger).toHaveBeenCalledWith('traffic-sfx', {
        zoom: 8,
        feature: { id: 'f1', properties: { congestion: 'severe' } },
      });
    });
  });

  describe('ambient layers', () => {
    it('updates context once on bind and again on moveend, aggregating numeric properties', () => {
      const layer: SoundLayerSpecification = {
        id: 'traffic-ambient',
        type: 'ambient',
        source: 'traffic-noise',
        'target-layer': 'traffic-lines',
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([
        { properties: { congestion: 0.2, road: 'main-st' } },
        { properties: { congestion: 0.8, road: 'oak-ave' } },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.updateContext).toHaveBeenCalledTimes(1);

      fakeMap.fire('moveend');

      expect(engine.updateContext).toHaveBeenCalledTimes(2);
      expect(engine.updateContext).toHaveBeenLastCalledWith('traffic-ambient', {
        zoom: 10,
        feature: { properties: { congestion: 0.5, road: 'main-st' } },
      });
    });

    it('aggregates a categorical property by its most frequent value, not the first match', () => {
      const layer: SoundLayerSpecification = {
        id: 'traffic-ambient',
        type: 'ambient',
        source: 'traffic-noise',
        'target-layer': 'traffic-lines',
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([
        { properties: { congestion: 'severe' } },
        { properties: { congestion: 'low' } },
        { properties: { congestion: 'low' } },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(engine.updateContext).toHaveBeenCalledWith('traffic-ambient', {
        zoom: 10,
        feature: { properties: { congestion: 'low' } },
      });
    });

    it('queries a target-featureset instead of target-layer when specified', () => {
      const layer: SoundLayerSpecification = {
        id: 'poi-ambient',
        type: 'ambient',
        source: 'poi-noise',
        'target-featureset': { featuresetId: 'poi', importId: 'basemap' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { density: 4 } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(fakeMap.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.objectContaining({ target: { featuresetId: 'poi', importId: 'basemap' } }),
      );
      expect(engine.updateContext).toHaveBeenCalledWith('poi-ambient', {
        zoom: 10,
        feature: { properties: { density: 4 } },
      });
    });

    it('re-evaluates on any sourcedata event for the target-layer source, ignoring other sources', () => {
      // Regression test: this used to filter on sourceDataType === 'content' only, but real-world
      // testing found that mapbox-gl-js's classic vector-tile sources never actually fire
      // sourceDataType: 'content' at all (unlike GeoJSON sources) — silently breaking reevaluation
      // for every classic-tileset-backed layer whenever a moveend landed before those tiles
      // finished loading. Now any sourcedata event for a matching sourceId re-evaluates,
      // regardless of sourceDataType (only the unrelated source is still ignored).
      const layer: SoundLayerSpecification = {
        id: 'traffic-ambient',
        type: 'ambient',
        source: 'traffic-noise',
        'target-layer': 'traffic-lines',
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.getLayer.mockReturnValue({ source: 'mapbox-traffic' });
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { congestion: 'severe' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.updateContext).toHaveBeenCalledTimes(1);

      // An update on an unrelated source does not trigger a re-evaluation
      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'other-source' });
      expect(engine.updateContext).toHaveBeenCalledTimes(1);

      // An update on the target source re-evaluates regardless of sourceDataType (including 'metadata')
      fakeMap.fire('sourcedata', { sourceDataType: 'metadata', sourceId: 'mapbox-traffic' });
      expect(engine.updateContext).toHaveBeenCalledTimes(2);

      fakeMap.fire('sourcedata', { sourceDataType: 'content', sourceId: 'mapbox-traffic' });
      expect(engine.updateContext).toHaveBeenCalledTimes(3);
    });

    it('throttles updates according to sound-update-interval', () => {
      const layer: SoundLayerSpecification = {
        id: 'traffic-ambient',
        type: 'ambient',
        source: 'traffic-noise',
        'target-layer': 'traffic-lines',
        layout: { 'sound-update-interval': 1000 },
      };
      const fakeMap = createFakeMap();
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { congestion: 'severe' } }]);
      const engine = createFakeEngine([layer]);
      vi.spyOn(Date, 'now').mockReturnValue(0);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.updateContext).toHaveBeenCalledTimes(1);

      fakeMap.fire('moveend');
      expect(engine.updateContext).toHaveBeenCalledTimes(1);
    });

    it('does not auto-bind (no reevaluation, no initial updateContext call) when the layer has no target-layer/target-featureset', () => {
      // Such a layer has no map feature to derive context from — it's meant to be driven entirely
      // by the app's own engine.updateContext() calls (e.g. a weather select feeding a
      // non-geometry app state into paint). Auto-binding here would clobber that app-set context with
      // a zoom-only one on the next map interaction (moveend/move/sourcedata) — a regression test
      // for the bug this fixes.
      const layer: SoundLayerSpecification = {
        id: 'weather-rain-ambient',
        type: 'ambient',
        source: 'weather-rain-ambient',
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.updateContext).not.toHaveBeenCalled();

      fakeMap.fire('moveend');
      expect(engine.updateContext).not.toHaveBeenCalled();
    });

    it('skips the query while zoom is outside minzoom/maxzoom', () => {
      const layer: SoundLayerSpecification = {
        id: 'traffic-ambient',
        type: 'ambient',
        source: 'traffic-noise',
        'target-layer': 'traffic-lines',
        minzoom: 6,
        maxzoom: 14,
      };
      const fakeMap = createFakeMap();
      fakeMap.setZoom(16);
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { congestion: 'severe' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(fakeMap.queryRenderedFeatures).not.toHaveBeenCalled();
      expect(engine.updateContext).not.toHaveBeenCalled();
    });
  });

  describe('bgm-state layers', () => {
    const layer: SoundLayerSpecification = {
      id: 'area-bgm-switch',
      type: 'bgm-state',
      source: 'area-bgm',
      'target-layer': 'area-polygons',
      layout: { 'sound-state-property': 'area-id' },
    };

    it('sets the active state from the feature under the map center', () => {
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([
        { properties: { 'area-id': 'downtown' } },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', 'downtown', {
        zoom: 10,
      });

      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { 'area-id': 'harbor' } }]);
      fakeMap.fire('moveend');
      expect(engine.setActiveState).toHaveBeenLastCalledWith('area-bgm-switch', 'harbor', {
        zoom: 10,
      });
    });

    it('treats zoom outside minzoom/maxzoom as if no feature were found, without querying', () => {
      const zoomLimitedLayer: SoundLayerSpecification = {
        ...layer,
        minzoom: 6,
        maxzoom: 14,
      };
      const fakeMap = createFakeMap();
      fakeMap.setZoom(16);
      const engine = createFakeEngine([zoomLimitedLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { 'area-id': 'downtown' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(fakeMap.queryRenderedFeatures).not.toHaveBeenCalled();
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', undefined, { zoom: 16 });
    });

    it('sets undefined when no feature is found at the map center', () => {
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', undefined, {
        zoom: 10,
      });
    });

    it('does not call setActiveState again for an unchanged state', () => {
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([
        { properties: { 'area-id': 'downtown' } },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      fakeMap.fire('moveend');

      expect(engine.setActiveState).toHaveBeenCalledTimes(1);
    });

    it('queries target-layer array in priority order, taking the first match', () => {
      const priorityLayer: SoundLayerSpecification = {
        id: 'terrain-bgm-switch',
        type: 'bgm-state',
        source: 'terrain-bgm',
        'target-layer': ['terrain-query-water', 'terrain-query-landuse'],
        layout: { 'sound-state-property': 'class' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([priorityLayer]);
      fakeMap.queryRenderedFeatures.mockImplementation((_geometry, options) => {
        const layers = (options as { layers: string[] }).layers;
        if (layers[0] === 'terrain-query-water') return [];
        return [{ properties: { class: 'wood' } }];
      });

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(fakeMap.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ layers: ['terrain-query-water'] }),
      );
      expect(fakeMap.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ layers: ['terrain-query-landuse'] }),
      );
      expect(engine.setActiveState).toHaveBeenCalledWith('terrain-bgm-switch', 'wood', { zoom: 10 });
    });

    it('resolves the state key via an Expression when sound-state-property is not a plain string', () => {
      const expressionLayer: SoundLayerSpecification = {
        id: 'terrain-bgm-switch',
        type: 'bgm-state',
        source: 'terrain-bgm',
        'target-layer': 'terrain-query-landuse',
        layout: {
          'sound-state-property': [
            'case',
            ['==', ['get', 'class'], 'wood'],
            'forest',
            ['==', ['get', 'class'], 'sand'],
            'desert',
            '',
          ],
        },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([expressionLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'sand' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(engine.setActiveState).toHaveBeenCalledWith('terrain-bgm-switch', 'desert', { zoom: 10 });
    });

    it('queries a target-featureset instead of target-layer when specified', () => {
      const featuresetLayer: SoundLayerSpecification = {
        id: 'poi-bgm-switch',
        type: 'bgm-state',
        source: 'poi-bgm',
        'target-featureset': { featuresetId: 'poi', importId: 'basemap' },
        layout: { 'sound-state-property': 'class' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([featuresetLayer]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'cafe' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(fakeMap.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ target: { featuresetId: 'poi', importId: 'basemap' } }),
      );
      expect(engine.setActiveState).toHaveBeenCalledWith('poi-bgm-switch', 'cafe', { zoom: 10 });
    });
  });

  describe('bgm-priority-groups', () => {
    const layers: SoundLayerSpecification[] = [
      { id: 'world-bgm', type: 'bgm-state', source: 'world-bgm', layout: { 'sound-state-property': 'unused' } },
      { id: 'area-bgm-switch', type: 'bgm-state', source: 'area-bgm', layout: { 'sound-state-property': 'unused' } },
    ];
    const group: BgmPriorityGroup = {
      id: 'area-bgm-priority',
      dimensions: {
        zoom: { kind: 'zoom' },
        terrain: { kind: 'query', 'target-layer': 'terrain-query-landuse', property: 'class' },
      },
      tiers: [
        { layer: 'world-bgm', match: { zoom: { lte: 2 } }, state: 'world' },
        { layer: 'area-bgm-switch', state: { 'from-dimension': 'terrain' } },
      ],
    };

    it('activates the fallback tier and silences the higher-priority tier when zoom is above the threshold', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      const engine = createFakeEngine(layers, [group]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'wood' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(engine.setActiveState).toHaveBeenCalledWith('world-bgm', undefined, { zoom: 10 });
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', 'wood', { zoom: 10 });
    });

    it('activates the higher-priority (world-view) tier and silences the fallback when zoom crosses the threshold', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(1);
      const engine = createFakeEngine(layers, [group]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'wood' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      expect(engine.setActiveState).toHaveBeenCalledWith('world-bgm', 'world', { zoom: 1 });
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', undefined, { zoom: 1 });
    });

    it('still silences non-winning tiers, but leaves the winner alone, when its state is undetermined', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      const engine = createFakeEngine(layers, [group]);
      fakeMap.queryRenderedFeatures.mockReturnValue([]); // no terrain feature found

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      // world-bgm (the higher-priority, non-winning tier) is still silenced unconditionally —
      // otherwise it could get stuck playing if it had been active from a previous, more specific
      // match. area-bgm-switch (the winner) is left untouched since its state can't be resolved.
      expect(engine.setActiveState).toHaveBeenCalledTimes(1);
      expect(engine.setActiveState).toHaveBeenCalledWith('world-bgm', undefined, { zoom: 10 });
    });

    it('keeps a previously-audible non-winning tier playing (does not cut it to silence) when the new winner cannot resolve its own state', () => {
      // Regression test for a real bug: a tier that was genuinely audible (e.g. a forest/night
      // override) got unconditionally silenced the instant a *different* tier nominally became
      // the winner, even when that new winner's own state was undetermined (e.g. the map moved
      // into a spot with no terrain feature at all). The old tier had nothing to hand off to, so
      // the result was total silence — even though "something was playing a moment ago" — until a
      // future update finally resolved a real state. Fixed by exempting the last tier that was
      // actually made audible from the unconditional-silence sweep whenever the new winner's state
      // is still unresolved.
      const specialLayers: SoundLayerSpecification[] = [
        { id: 'special-bgm', type: 'bgm-state', source: 'special-bgm', layout: { 'sound-state-property': 'unused' } },
        ...layers,
      ];
      const specialGroup: BgmPriorityGroup = {
        id: 'area-bgm-priority',
        dimensions: { terrain: { kind: 'query', 'target-layer': 'terrain-query-landuse', property: 'class' } },
        tiers: [
          { layer: 'special-bgm', match: { terrain: 'special' }, state: 'special' },
          { layer: 'area-bgm-switch', state: { 'from-dimension': 'terrain' } },
        ],
      };
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      const engine = createFakeEngine(specialLayers, [specialGroup]);

      // 1) special-bgm genuinely wins and becomes audible.
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'special' } }]);
      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.setActiveState).toHaveBeenLastCalledWith('special-bgm', 'special', { zoom: 10 });
      engine.setActiveState.mockClear();

      // 2) Map moves somewhere with no terrain feature at all. special-bgm no longer matches, so
      // the fallback tier (area-bgm-switch) becomes the nominal winner — but its own state is
      // undetermined (no feature => undefined). special-bgm must NOT be silenced here.
      fakeMap.queryRenderedFeatures.mockReturnValue([]);
      fakeMap.fire('sourcedata', { sourceId: undefined });
      expect(engine.setActiveState).not.toHaveBeenCalled();

      // 3) Only once the fallback tier's state actually resolves does special-bgm finally get
      // silenced and the real replacement take over.
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'other' } }]);
      fakeMap.fire('sourcedata', { sourceId: undefined });
      expect(engine.setActiveState).toHaveBeenCalledWith('special-bgm', undefined, { zoom: 10 });
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', 'other', { zoom: 10 });
    });

    it('re-evaluates on a sourcedata event with no sourceDataType (classic vector-tile sources never actually send "content")', () => {
      // Regression test for a real bug: mapbox-gl-js's classic vector-tile sources (what
      // addTerrainQueryLayers/addCountryQueryLayers add) were found to never fire
      // sourceDataType: 'content' at all — bindReevaluate used to filter on exactly that, silently
      // breaking this group's reevaluation whenever a moveend landed before those tiles finished
      // loading (BGM would then stay stuck/stale forever, since no further moveend was guaranteed).
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      fakeMap.getLayer.mockImplementation((id) => (id === 'terrain-query-landuse' ? { source: 'mapbox-streets-v8' } : undefined));
      fakeMap.queryRenderedFeatures.mockReturnValue([]); // undetermined at first (tiles not loaded yet)
      const engine = createFakeEngine(layers, [group]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.setActiveState).not.toHaveBeenCalledWith('area-bgm-switch', expect.anything(), expect.anything());

      // The tiles "finish loading" — a real mapbox-gl-js sourcedata event for this source, with no
      // sourceDataType at all (as observed for classic vector-tile sources in practice).
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'wood' } }]);
      fakeMap.fire('sourcedata', { sourceId: 'mapbox-streets-v8' });

      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', 'wood', { zoom: 10 });
    });

    it('calls onBgmPriorityUpdate on every reevaluation, so a debug display can stay in sync even off sourcedata alone', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { class: 'wood' } }]);
      const engine = createFakeEngine(layers, [group]);
      const onBgmPriorityUpdate = vi.fn();

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, { onBgmPriorityUpdate });
      expect(onBgmPriorityUpdate).toHaveBeenCalledWith({ groupId: 'area-bgm-priority' });

      onBgmPriorityUpdate.mockClear();
      fakeMap.fire('sourcedata', { sourceId: 'mapbox-streets-v8' });
      expect(onBgmPriorityUpdate).toHaveBeenCalledTimes(1);
    });

    it('excludes tier-managed bgm-state layers from the normal per-layer auto-wiring', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      const targetLayerGroup: BgmPriorityGroup = {
        id: 'area-bgm-priority',
        dimensions: { zoom: { kind: 'zoom' } },
        tiers: [{ layer: 'area-bgm-switch', state: 'x' }],
      };
      const autoWiredLayer: SoundLayerSpecification = {
        id: 'area-bgm-switch',
        type: 'bgm-state',
        source: 'area-bgm',
        'target-layer': 'area-polygons', // would normally auto-wire via bindBgmStateLayer
        layout: { 'sound-state-property': 'area-id' },
      };
      const engine = createFakeEngine([autoWiredLayer], [targetLayerGroup]);
      fakeMap.queryRenderedFeatures.mockReturnValue([{ properties: { 'area-id': 'downtown' } }]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      // Only the priority-group's own setActiveState('x') should have happened — never
      // bindBgmStateLayer's independent 'downtown' read from area-polygons.
      expect(engine.setActiveState).toHaveBeenCalledTimes(1);
      expect(engine.setActiveState).toHaveBeenCalledWith('area-bgm-switch', 'x', { zoom: 10 });
    });

    it('leaves a query dimension undefined (not the Expression\'s "no feature" branch value) when no feature is found at all', () => {
      // Regression test: a `['!', ['has', 'class']]`-style Expression can't distinguish "no
      // feature was found here" from "a feature was found but it has no class property" — both
      // make `has('class')` false. If the dimension resolver evaluated the Expression anyway on a
      // missing feature, terrain would incorrectly resolve to 'sea' (the Expression's "no class"
      // branch) whenever tiles haven't loaded yet, instead of staying undefined.
      const noClassMeansSeaGroup: BgmPriorityGroup = {
        id: 'area-bgm-priority',
        dimensions: {
          terrain: {
            kind: 'query',
            'target-layer': 'terrain-query-water',
            property: ['case', ['!', ['has', 'class']], 'sea', ''],
          },
        },
        tiers: [{ layer: 'area-bgm-switch', state: { 'from-dimension': 'terrain' } }],
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine(layers, [noClassMeansSeaGroup]);
      fakeMap.queryRenderedFeatures.mockReturnValue([]); // no feature at all, not even a water one

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      // The winner's state is undetermined (undefined), so per bgm-state's allow-silence
      // convention, setActiveState must not be called for it at all (not with 'sea').
      expect(engine.setActiveState).not.toHaveBeenCalled();
    });

    it('reads a config-property dimension from the map and re-evaluates on a styledata (dataType: style) event', () => {
      const fakeMap = createFakeMap();
      fakeMap.setZoom(10);
      fakeMap.setConfigProperty('basemap', 'lightPreset', 'day');
      const lightGroup: BgmPriorityGroup = {
        id: 'light-priority',
        dimensions: { lightPreset: { kind: 'config-property', scope: 'basemap', 'config-property': 'lightPreset' } },
        tiers: [
          { layer: 'world-bgm', match: { lightPreset: 'night' }, state: 'night-variant' },
          { layer: 'area-bgm-switch', state: 'day-variant' },
        ],
      };
      const engine = createFakeEngine(layers, [lightGroup]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.setActiveState).toHaveBeenLastCalledWith('area-bgm-switch', 'day-variant', { zoom: 10 });

      fakeMap.setConfigProperty('basemap', 'lightPreset', 'night');
      fakeMap.fire('styledata', { dataType: 'style' });

      expect(engine.setActiveState).toHaveBeenLastCalledWith('world-bgm', 'night-variant', { zoom: 10 });
    });
  });

  describe('destroy()', () => {
    it('stops forwarding map events after destroy()', () => {
      const layer: SoundLayerSpecification = {
        id: 'poi-click-sfx',
        type: 'event',
        source: 'poi-sfx',
        'target-layer': 'poi-symbols',
        layout: { 'sound-trigger': 'click' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);

      const adapter = new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      adapter.destroy();
      fakeMap.fire('click:poi-symbols', { features: [{ id: 'f1', properties: {} }] });

      expect(engine.trigger).not.toHaveBeenCalled();
    });

    it('removes the interaction registered for a target-featureset event layer', () => {
      const layer: SoundLayerSpecification = {
        id: 'poi-click-sfx',
        type: 'event',
        source: 'poi-sfx',
        'target-featureset': { featuresetId: 'poi', importId: 'basemap' },
        layout: { 'sound-trigger': 'click' },
      };
      const fakeMap = createFakeMap();
      const engine = createFakeEngine([layer]);

      const adapter = new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      adapter.destroy();

      expect(fakeMap.removeInteraction).toHaveBeenCalledWith('sound-style:poi-click-sfx');
      fakeMap.fireInteraction('sound-style:poi-click-sfx', {
        feature: { id: 'f1', properties: {} },
      });
      expect(engine.trigger).not.toHaveBeenCalled();
    });
  });
});

describe('getFeatureLngLat', () => {
  it('returns the coordinates of a Point feature', () => {
    expect(getFeatureLngLat({ geometry: { type: 'Point', coordinates: [1, 2] } })).toEqual([1, 2]);
  });

  it('returns undefined for non-Point geometry or missing geometry', () => {
    expect(getFeatureLngLat({ geometry: { type: 'LineString', coordinates: [] } })).toBeUndefined();
    expect(getFeatureLngLat({})).toBeUndefined();
  });
});

describe('metersPerPixelAtLat', () => {
  it('decreases as zoom increases', () => {
    expect(metersPerPixelAtLat(37.7749, 15)).toBeLessThan(metersPerPixelAtLat(37.7749, 10));
  });
});

describe('queryFeaturesWithinRadius', () => {
  function createFakeMapForRadiusQuery(features: unknown[]) {
    const queryRenderedFeatures = vi.fn().mockReturnValue(features);
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }),
      getZoom: () => 12,
      project: () => ({ x: 0, y: 0 }),
      queryRenderedFeatures,
    };
    return { map: map as unknown as MapboxMap, queryRenderedFeatures };
  }

  it('keeps only features within radiusMeters and sorts by distance ascending', () => {
    const near = { id: 'near', properties: {}, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    const far = { id: 'far', properties: {}, geometry: { type: 'Point', coordinates: [0.003, 0] } };
    const outside = { id: 'outside', properties: {}, geometry: { type: 'Point', coordinates: [1, 0] } };
    const { map } = createFakeMapForRadiusQuery([far, near, outside]);

    const results = queryFeaturesWithinRadius(map, { layers: ['poi-symbols'], radiusMeters: 500 });

    expect(results.map((r) => r.feature.id)).toEqual(['near', 'far']);
    expect(results[0]?.distanceMeters).toBeLessThan(results[1]?.distanceMeters ?? Infinity);
  });

  it('queries by target-featureset when layers is not given', () => {
    const { map, queryRenderedFeatures } = createFakeMapForRadiusQuery([]);
    queryFeaturesWithinRadius(map, {
      target: { featuresetId: 'poi', importId: 'basemap' },
      radiusMeters: 500,
    });

    expect(queryRenderedFeatures).toHaveBeenCalledWith(expect.anything(), {
      target: { featuresetId: 'poi', importId: 'basemap' },
      filter: undefined,
    });
  });
});

describe('findMatchingLayerByPrefix', () => {
  it('returns the suffix of the first layer whose filter matches', () => {
    const layers: SoundLayerSpecification[] = [
      {
        id: 'poi-ping-food',
        type: 'event',
        source: 'poi-sfx',
        filter: ['==', ['get', 'class'], 'restaurant'],
        layout: { 'sound-trigger': 'click' },
      },
    ];
    const engine = {
      getLayerIds: () => layers.map((l) => l.id),
      getLayer: (id: string) => layers.find((l) => l.id === id),
    };

    expect(
      findMatchingLayerByPrefix(engine as unknown as SoundStyleEngine, 'poi-ping-', {
        properties: { class: 'restaurant' },
      }),
    ).toBe('food');
    expect(
      findMatchingLayerByPrefix(engine as unknown as SoundStyleEngine, 'poi-ping-', {
        properties: { class: 'museum' },
      }),
    ).toBeUndefined();
  });
});

describe('addTerrainQueryLayers / addCountryQueryLayers', () => {
  function createFakeStyleMap() {
    const addSource = vi.fn();
    const addLayer = vi.fn();
    return { map: { addSource, addLayer } as unknown as MapboxMap, addSource, addLayer };
  }

  it('adds the water/landuse/landcover hidden layers', () => {
    const { map, addLayer } = createFakeStyleMap();
    addTerrainQueryLayers(map);
    expect(addLayer.mock.calls.map(([layer]) => (layer as { id: string }).id)).toEqual([
      'terrain-query-water',
      'terrain-query-landuse',
      'terrain-query-landcover',
    ]);
  });

  it('adds the country-query hidden layer', () => {
    const { map, addLayer } = createFakeStyleMap();
    addCountryQueryLayers(map);
    expect(addLayer.mock.calls.map(([layer]) => (layer as { id: string }).id)).toEqual(['country-query']);
  });

  it('accepts overridden layer ids', () => {
    const { map, addLayer } = createFakeStyleMap();
    addTerrainQueryLayers(map, { water: 'my-water', landuse: 'my-landuse', landcover: 'my-landcover' });
    addCountryQueryLayers(map, 'my-country');
    expect(addLayer.mock.calls.map(([layer]) => (layer as { id: string }).id)).toEqual([
      'my-water',
      'my-landuse',
      'my-landcover',
      'my-country',
    ]);
  });
});

describe('MapboxSoundAdapter ensureTerrainQueryLayers/ensureCountryQueryLayers', () => {
  it('adds the hidden layers (default ids) when none of them exist yet', () => {
    const fakeMap = createFakeMap();
    const engine = createFakeEngine([]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, {
      ensureTerrainQueryLayers: true,
      ensureCountryQueryLayers: true,
    });

    expect(fakeMap.getLayer('terrain-query-water')).toBeTruthy();
    expect(fakeMap.getLayer('terrain-query-landuse')).toBeTruthy();
    expect(fakeMap.getLayer('terrain-query-landcover')).toBeTruthy();
    expect(fakeMap.getLayer('country-query')).toBeTruthy();
  });

  it('uses custom ids when given a partial override object', () => {
    const fakeMap = createFakeMap();
    const engine = createFakeEngine([]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, {
      ensureTerrainQueryLayers: { water: 'my-water' },
      ensureCountryQueryLayers: 'my-country',
    });

    expect(fakeMap.getLayer('my-water')).toBeTruthy();
    // Fields not overridden fall back to the default ids.
    expect(fakeMap.getLayer('terrain-query-landuse')).toBeTruthy();
    expect(fakeMap.getLayer('my-country')).toBeTruthy();
  });

  it("does nothing if the app already has one of the terrain layers (avoids collision/double-add)", () => {
    const fakeMap = createFakeMap();
    fakeMap.presetLayer('terrain-query-water'); // as if the app added its own equivalent already
    const engine = createFakeEngine([]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, {
      ensureTerrainQueryLayers: true,
    });

    // Since one of the three already existed, the adapter must not add any of them (all-or-nothing,
    // to avoid a partial re-add against a source the app might already own too).
    expect(fakeMap.addLayer).not.toHaveBeenCalled();
  });

  it("destroy() removes only the layers/sources it actually added, never ones the app already had", () => {
    const fakeMap = createFakeMap();
    fakeMap.presetLayer('country-query'); // app already had this one
    const engine = createFakeEngine([]);

    const adapter = new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, {
      ensureTerrainQueryLayers: true, // none pre-existing -> adapter adds all 3 + 2 sources
      ensureCountryQueryLayers: true, // pre-existing -> adapter must skip and never remove it
    });
    expect(fakeMap.getLayer('terrain-query-water')).toBeTruthy();
    expect(fakeMap.getLayer('country-query')).toBeTruthy(); // still there (app's own)

    adapter.destroy();

    expect(fakeMap.getLayer('terrain-query-water')).toBeFalsy();
    expect(fakeMap.getLayer('terrain-query-landuse')).toBeFalsy();
    expect(fakeMap.getLayer('terrain-query-landcover')).toBeFalsy();
    expect(fakeMap.getSource('mapbox-streets-v8')).toBeFalsy();
    expect(fakeMap.getSource('mapbox-terrain-v2')).toBeFalsy();
    // The app's pre-existing country-query layer must survive destroy() untouched.
    expect(fakeMap.getLayer('country-query')).toBeTruthy();
    expect(fakeMap.removeLayer).not.toHaveBeenCalledWith('country-query');
  });
});

describe('MapboxSoundAdapter proximity-trigger-groups', () => {
  function poiPingLayer(category: string): SoundLayerSpecification {
    return {
      id: `poi-ping-${category}`,
      type: 'event',
      source: 'poi-sfx',
      layout: { 'sound-trigger': 'click' },
    };
  }

  it('triggers the nearest feature per category, from a plain-property source', () => {
    const fakeMap = createFakeMap();
    const near = { id: 'f1', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    const far = { id: 'f2', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.003, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([far, near]);
    const engine = createFakeEngine([poiPingLayer('shop')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

    expect(engine.trigger).toHaveBeenCalledTimes(1);
    expect(engine.trigger).toHaveBeenCalledWith(
      'poi-ping-shop',
      expect.objectContaining({ feature: expect.objectContaining({ id: 'f1' }) }),
      { source: 'proximity' },
    );
  });

  it('resolves category via layer-prefix matching (matching an existing filtered event layer)', () => {
    const fakeMap = createFakeMap();
    const feature = { id: 'p1', properties: { maki: 'restaurant' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([feature]);
    const restaurantLayer: SoundLayerSpecification = {
      id: 'poi-ping-restaurant',
      type: 'event',
      source: 'poi-sfx',
      filter: ['==', ['get', 'maki'], 'restaurant'],
      layout: { 'sound-trigger': 'click' },
    };
    const engine = createFakeEngine([restaurantLayer], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'layer-prefix', 'target-featureset': { featuresetId: 'poi', importId: 'basemap' } }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

    expect(engine.trigger).toHaveBeenCalledWith(
      'poi-ping-restaurant',
      expect.anything(),
      { source: 'proximity' },
    );
  });

  it('caps the number of triggers at max-per-tick, closest categories winning', () => {
    const fakeMap = createFakeMap();
    const shop = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    const food = { id: 'b', properties: { category: 'food' }, geometry: { type: 'Point', coordinates: [0.002, 0] } };
    const park = { id: 'c', properties: { category: 'park' }, geometry: { type: 'Point', coordinates: [0.003, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([park, food, shop]);
    const engine = createFakeEngine(
      [poiPingLayer('shop'), poiPingLayer('food'), poiPingLayer('park')],
      [],
      [
        {
          id: 'poi-proximity',
          sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
          'radius-meters': 500,
          'layer-prefix': 'poi-ping-',
          'max-per-tick': 2,
        },
      ],
    );

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

    expect(engine.trigger).toHaveBeenCalledTimes(2);
    expect(engine.trigger).toHaveBeenCalledWith('poi-ping-shop', expect.anything(), { source: 'proximity' });
    expect(engine.trigger).toHaveBeenCalledWith('poi-ping-food', expect.anything(), { source: 'proximity' });
    expect(engine.trigger).not.toHaveBeenCalledWith('poi-ping-park', expect.anything(), expect.anything());
  });

  // Regression test (2026-09-12): max-per-tick is only a cap per single re-evaluation, so
  // during a pan/zoom, moveend/sourcedata can trigger many re-evaluations in a short time, and
  // even with a per-tick cap the total keeps piling up (reported as ~10 entries showing up in
  // the #now-playing list).
  // max-concurrent is a cap that carries across ticks, computed by subtracting the number of
  // layers already reported as playing.
  it('caps new triggers at max-concurrent, counting layers the engine reports as still playing', () => {
    const fakeMap = createFakeMap();
    // No candidates at construction time — so as not to fire anything before the listener is
    // registered (onLayerPlay/onLayerStop are only registered inside bindProximityTriggerGroup,
    // i.e. inside the constructor, so an engine.emit() before that point would not be received).
    fakeMap.queryRenderedFeatures.mockReturnValue([]);
    const engine = createFakeEngine([poiPingLayer('shop'), poiPingLayer('food')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        'max-concurrent': 3,
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

    // Have the engine report 3 layers as already playing (2 matching this group's prefix + 1 unrelated).
    engine.emit({ type: 'layer:play', layerId: 'poi-ping-park' });
    engine.emit({ type: 'layer:play', layerId: 'poi-ping-museum' });
    engine.emit({ type: 'layer:play', layerId: 'unrelated-layer' }); // different prefix, not counted

    const shop = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    const food = { id: 'b', properties: { category: 'food' }, geometry: { type: 'Point', coordinates: [0.002, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([shop, food]);
    fakeMap.fire('moveend');

    // Remaining slots are 3-2=1, so only 1 of the 2 candidates fires (shop wins by distance).
    expect(engine.trigger).toHaveBeenCalledTimes(1);
    expect(engine.trigger).toHaveBeenCalledWith('poi-ping-shop', expect.anything(), { source: 'proximity' });
  });

  // Regression test (2026-09-12): once-only dedupes per feature, so distinct features in the
  // same category can still fire repeatedly in a short time. category-cooldown-ms throttles at
  // the category level.
  it('suppresses re-firing the same category within category-cooldown-ms, even for a different feature', () => {
    vi.useFakeTimers();
    try {
      const fakeMap = createFakeMap();
      const shop1 = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
      const shop2 = { id: 'b', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.002, 0] } };
      fakeMap.queryRenderedFeatures.mockReturnValue([shop1]);
      const engine = createFakeEngine([poiPingLayer('shop')], [], [
        {
          id: 'poi-proximity',
          sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
          'radius-meters': 500,
          'layer-prefix': 'poi-ping-',
          'category-cooldown-ms': 5000,
        },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
      expect(engine.trigger).toHaveBeenCalledTimes(1);

      // Even when switching to a different feature (shop2), it does not re-fire while the cooldown is active.
      fakeMap.queryRenderedFeatures.mockReturnValue([shop2]);
      fakeMap.fire('moveend');
      expect(engine.trigger).toHaveBeenCalledTimes(1);

      // Once the cooldown expires, it fires again.
      vi.advanceTimersByTime(5000);
      fakeMap.fire('moveend');
      expect(engine.trigger).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('staggers triggers by stagger-ms', () => {
    vi.useFakeTimers();
    try {
      const fakeMap = createFakeMap();
      const shop = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
      const food = { id: 'b', properties: { category: 'food' }, geometry: { type: 'Point', coordinates: [0.002, 0] } };
      fakeMap.queryRenderedFeatures.mockReturnValue([shop, food]);
      const engine = createFakeEngine([poiPingLayer('shop'), poiPingLayer('food')], [], [
        {
          id: 'poi-proximity',
          sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
          'radius-meters': 500,
          'layer-prefix': 'poi-ping-',
          'stagger-ms': 400,
        },
      ]);

      new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);

      // Both fires go through setTimeout (index 0 at delay 0, index 1 at delay 400ms) — advancing
      // by 0 flushes the first without yet triggering the second.
      vi.advanceTimersByTime(0);
      expect(engine.trigger).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(400);
      expect(engine.trigger).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('once-only skips a feature already triggered, across reevaluation cycles', () => {
    const fakeMap = createFakeMap();
    const feature = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([feature]);
    const engine = createFakeEngine([poiPingLayer('shop')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        'once-only': true,
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
    expect(engine.trigger).toHaveBeenCalledTimes(1);

    fakeMap.fire('moveend');
    expect(engine.trigger).toHaveBeenCalledTimes(1); // still 1 — same feature, not re-triggered
  });

  it('setProximityOnceOnly overrides the Style default at runtime', () => {
    const fakeMap = createFakeMap();
    const feature = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([feature]);
    const engine = createFakeEngine([poiPingLayer('shop')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        'once-only': true,
      },
    ]);

    const adapter = new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
    expect(engine.trigger).toHaveBeenCalledTimes(1);

    adapter.setProximityOnceOnly('poi-proximity', false);
    fakeMap.fire('moveend');
    expect(engine.trigger).toHaveBeenCalledTimes(2); // once-only turned off -> fires again
  });

  it('calls onProximityDetected with every detected category, before dedup/cap/once-only', () => {
    const fakeMap = createFakeMap();
    const shop1 = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    const shop2 = { id: 'b', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.0015, 0] } };
    const food = { id: 'c', properties: { category: 'food' }, geometry: { type: 'Point', coordinates: [0.002, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([shop1, shop2, food]);
    const onProximityDetected = vi.fn();
    const engine = createFakeEngine([poiPingLayer('shop'), poiPingLayer('food')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        'max-per-tick': 1,
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, { onProximityDetected });

    expect(onProximityDetected).toHaveBeenCalledWith({ groupId: 'poi-proximity', categories: ['shop', 'food'] });
  });

  it('skips the query entirely and reports no detections when zoomed below minzoom', () => {
    const fakeMap = createFakeMap();
    fakeMap.setZoom(5);
    const feature = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([feature]);
    const onProximityDetected = vi.fn();
    const engine = createFakeEngine([poiPingLayer('shop')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        minzoom: 11,
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine, { onProximityDetected });

    expect(fakeMap.queryRenderedFeatures).not.toHaveBeenCalled();
    expect(engine.trigger).not.toHaveBeenCalled();
    expect(onProximityDetected).toHaveBeenCalledWith({ groupId: 'poi-proximity', categories: [] });
  });

  it('resumes detection once zoomed back into the minzoom/maxzoom range', () => {
    const fakeMap = createFakeMap();
    fakeMap.setZoom(5);
    const feature = { id: 'a', properties: { category: 'shop' }, geometry: { type: 'Point', coordinates: [0.001, 0] } };
    fakeMap.queryRenderedFeatures.mockReturnValue([feature]);
    const engine = createFakeEngine([poiPingLayer('shop')], [], [
      {
        id: 'poi-proximity',
        sources: [{ kind: 'property', 'target-layer': 'poi-symbols', property: 'category' }],
        'radius-meters': 500,
        'layer-prefix': 'poi-ping-',
        minzoom: 11,
      },
    ]);

    new MapboxSoundAdapter(fakeMap.map, engine as unknown as SoundStyleEngine);
    expect(engine.trigger).not.toHaveBeenCalled();

    fakeMap.setZoom(13);
    fakeMap.fire('moveend');
    expect(engine.trigger).toHaveBeenCalledWith('poi-ping-shop', expect.anything(), { source: 'proximity' });
  });
});
