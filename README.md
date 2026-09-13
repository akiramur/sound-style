# sound-style

A declarative sound engine for the Web / WebGIS, modeled on the design philosophy of the Mapbox GL
JS Style Spec. Sounds triggered by camera movement, zoom, POI taps, entering/leaving an area, or
changes in data density are defined declaratively in a `sound-style.json`, so playback is driven by
data instead of scattering audio calls through application code.

_日本語版: [README-ja.md](./README-ja.md)_

```json
{
  "version": 1,
  "sources": {
    "poi-sfx": {
      "type": "audio-sprite",
      "url": "/audio/poi-sfx.mp3",
      "sprite": { "select": { "start": 0, "end": 0.4 } }
    }
  },
  "sound-layers": [
    {
      "id": "poi-click-sfx",
      "type": "event",
      "source": "poi-sfx",
      "sound-clip": "select",
      "target-layer": "poi-symbols",
      "layout": { "sound-trigger": "click" },
      "paint": { "sound-volume": 0.8 }
    }
  ]
}
```

## Packages

This repository is a pnpm workspaces monorepo.

| Package | Description |
|---|---|
| [`@sound-style/core`](./packages/core) | Framework-agnostic core: Web Audio API control, `sound-style.json` parsing/validation, Mapbox Expression evaluation |
| [`@sound-style/mapbox-gl`](./packages/mapbox-gl) | The project's Mapbox GL JS binding, auto-wiring map events (move, click, queryRenderedFeatures, etc.) |
| [`examples/vanilla`](./examples/vanilla) | A clean, minimal example app for SDK users (vanilla JS + Mapbox GL JS) |

## Development

```bash
pnpm install
pnpm build       # build all packages
pnpm test        # run unit tests across all packages
pnpm lint        # ESLint
pnpm typecheck   # type checking
```

See [`examples/vanilla/README.md`](./examples/vanilla/README.md) to run the example app.

## Disclaimer

sound-style is an independent personal project. It is not affiliated with, endorsed by, or
officially supported by Mapbox. "Mapbox" and "Mapbox GL JS" are trademarks of Mapbox, Inc.

While this project itself is MIT-licensed, `@sound-style/core` depends directly on
`@mapbox/mapbox-gl-style-spec`, which is licensed under the Mapbox TOS rather than MIT — see
[`packages/core`'s README](./packages/core/README.md#third-party-licenses) for details.

## License

[MIT](./LICENSE)
