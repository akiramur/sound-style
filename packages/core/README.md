# @sound-style/core

A framework-agnostic, declarative sound engine for the Web Audio API. It has no dependency on
Mapbox GL JS itself — no map instance is required (map integration is handled by
[`@sound-style/mapbox-gl`](../mapbox-gl)) — though see **Third-party licenses** below regarding
its Expression-evaluation dependency.

_日本語版: [README-ja.md](./README-ja.md)_

## Install

```bash
npm install @sound-style/core
```

## Usage

```ts
import { SoundStyleEngine, validateSoundStyle } from '@sound-style/core';

const style = validateSoundStyle({
  version: 1,
  sources: {
    'poi-sfx': {
      type: 'audio-sprite',
      url: '/audio/poi-sfx.mp3',
      sprite: { select: { start: 0, end: 0.4 } },
    },
  },
  'sound-layers': [
    {
      id: 'poi-click-sfx',
      type: 'event',
      source: 'poi-sfx',
      'sound-clip': 'select',
      layout: { 'sound-trigger': 'click' },
      paint: { 'sound-volume': 0.8 },
    },
  ],
});

// Creating/resuming the AudioContext must be triggered by a user gesture
// (click, etc.) due to browser autoplay policies.
const audioContext = new AudioContext();
await audioContext.resume();

const engine = new SoundStyleEngine({ audioContext });
engine.on('error', (e) => console.error(e.layerId, e.error));
await engine.load(style);

// Fire a one-shot `event` layer
engine.trigger('poi-click-sfx');
```

### The 3 `sound-layers` types

- **`event`**: a one-shot sound effect (e.g. a POI click) played via
  `engine.trigger(layerId, context?)`
- **`ambient`**: a continuous ambient sound whose volume/pitch/etc. track zoom or feature
  properties over time, driven by repeated calls to `engine.updateContext(layerId, context)`
- **`bgm-state`**: background music that crossfades between states (per
  `paint['sound-fade-duration']`) via `engine.setActiveState(layerId, stateKey)`

Call these APIs directly if you're wiring up Mapbox GL JS (or any other engine) yourself. To wire
map events into `SoundStyleEngine` automatically, use [`@sound-style/mapbox-gl`](../mapbox-gl).

### The `sound-style.json` schema

Type definitions live in [`src/types.ts`](./src/types.ts), and the JSON Schema (Draft-07) in
[`schema/sound-style.schema.json`](./schema/sound-style.schema.json).

`validateSoundStyle()` validates against this JSON Schema and throws a
`SoundStyleValidationError` on failure.

## Main API

| API | Description |
|---|---|
| `SoundStyleEngine` | Loads a style document, manages the audio graph, and controls playback |
| `AssetManager` | Fetches/decodes/caches audio sources and resolves audio-sprite clip ranges (streams BGM via `<audio>` elements instead of fully decoding them) |
| `ExpressionEvaluator` | Compiles and evaluates Mapbox Expressions (`interpolate`/`match`/`get`/etc.) |
| `validateSoundStyle()` | Validates a `sound-style.json` document against the schema |

## Third-party licenses

This package (`@sound-style/core` itself) is MIT-licensed, but it depends directly on
[`@mapbox/mapbox-gl-style-spec`](https://www.npmjs.com/package/@mapbox/mapbox-gl-style-spec) for
Expression compilation/evaluation. That package is **not MIT** — it's licensed under the
[Mapbox TOS](https://www.mapbox.com/legal/tos/), which requires a current, active Mapbox account
in good standing. Installing `@sound-style/core` pulls this dependency in transitively, so using it
means you're also subject to the Mapbox TOS for that portion of the dependency tree — even though
you never call any Mapbox GL JS map API directly.
