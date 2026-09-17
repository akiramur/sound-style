# sound-style examples

A clean, minimal example of using `@sound-style/core` and `@sound-style/mapbox-gl` on a real
Mapbox GL JS map — meant as the reference for SDK users. It showcases:

- **POI click SE**: clicking a marker on the map plays a sound effect (`event` type)
- **Traffic SE**: judges congestion near the map center from Mapbox's real traffic tileset
  (`mapbox-traffic-v1`) and plays a single car-horn SE, both when the map is moved (`moveend`) and,
  via polling, when the traffic condition changes while the map is still (`event` type; not a
  continuing ambient. Independent of POI detection's count/once-only limits)
- **Terrain BGM switching**: the BGM crossfades based on the water/landcover (sea/desert/forest/
  urban) at the map center, plus zooming out to world-view level for a dedicated ambient track,
  regardless of terrain/country/Light preset (`bgm-state` type; the whole multi-dimension,
  priority-tiered arbitration is declarative Style content — a `bgm-priority-groups` entry in the
  Style JSON). This can be overridden
  by up to three increasingly specific combinations — country x terrain, Light preset x terrain,
  and country x Light preset x terrain — each with its own dedicated BGM (currently: Japan plays
  its own BGM for forest/urban, a forest turns eerie at night everywhere, and Japan's urban BGM
  gets a hushed night variant)
- **Map-center POI detection SE**: a sound effect plays based on the kind of real POI (restaurant,
  park, church, airport, train station, etc.) that enters within a 500m radius of the map center
  (`event` type, using Mapbox Standard's POI featureset. Closer POIs are prioritized)
- **Light preset switching SE**: a sound effect plays when switching between dawn/day/dusk/night
  (`event` type). In addition to manual selection, it also auto-follows by estimating the local time
  from the map center's longitude every time the map is moved (see `estimateLocalHour`/
  `updateAutoLightPreset` in `src/main.ts`; being a rough approximation, it doesn't account for real
  timezone boundaries or DST)
- **Move-to city-jump SE**: an SE plays alongside the camera move to San Francisco/Tokyo/Helsinki/
  Minsk/Washington, D.C. (`event` type). You can pick the move animation (`flyTo`/`easeTo`/`jumpTo`),
  each playing a different SE

The audio is served from [`sound-style-assets`](https://github.com/akiramur/sound-style-assets),
which mixes real CC0/CC-BY-licensed sources with custom synthesis — see that repository's
`NOTICE.md` for the per-file breakdown and sources.

## Setup

1. Get a Mapbox access token (e.g. from a company account)
2. Copy `.env.local.example` to `.env.local` and set your token

   ```bash
   cp .env.local.example .env.local
   # Edit .env.local and set VITE_MAPBOX_ACCESS_TOKEN
   ```

   By default this app loads its audio from the `sound-style-assets` CDN (see
   `.env.local.example` for the `VITE_AUDIO_BASE_URL` it's preconfigured with). Point it at your
   own hosting by overriding that variable — this app has no local `public/audio-basic/` fallback
   (that's `apps/dev-app`'s job, for internal debugging with unreleased/licensed assets).

3. Start the dev server

   ```bash
   pnpm --filter @sound-style/example-vanilla dev
   ```

4. Open it in a browser and press the "Enable audio" button before interacting with it
   (browser autoplay policies don't allow sound without a user gesture)
