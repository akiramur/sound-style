# sound-style halloween example

A themed example of using `@sound-style/core` and `@sound-style/mapbox-gl` — same SDK, a
different Style. It showcases:

- **A dark, "flashlight" map**: a fixed CSS vignette darkens everything outside a circle at the
  center of the screen, so the map reads as lit by a torch rather than fully visible (pure CSS,
  no canvas) — this is presentation, not sound-style content, but it's the whole reason this demo
  exists as a separate app from `apps/examples/vanilla`.
- **Ghost annotations**: whichever haunted POI most recently played a sound gets a translucent,
  wispy white ghost that fades in, floats, and fades out over it — one of 4 AI-generated (Gemini)
  images per POI category (see `public/ghost-images/NOTICE.md`), not hand-drawn — the opaque
  black-background renders were converted to real alpha transparency (luminance-as-alpha), then
  resized to marker scale and kept a plain monochrome glow via CSS `filter`/`opacity` (no
  per-category hue tint, no icon overlay). Unlike the vanilla example's GL-layer annotation, ghosts
  are `mapboxgl.Marker` elements driven by plain CSS transitions, tied directly to the SDK's
  `layer:play`/`layer:stop` events (see `src/ghosts.ts`, `src/main.ts`).
- **POI click/proximity SE**: clicking a haunted POI, or letting one drift within ~500m of the
  map center, plays its themed sound effect (`event` type + a single `proximity-trigger-groups`
  entry — no POI-detection-radius debug circle is shown in this demo, unlike the vanilla example).
  Concurrency matches the vanilla example's own `poi-proximity` group exactly: at most 3 detections
  fire per cycle, at most 4 sounds play at once, and a given category won't re-fire for 8s
  (`max-per-tick`/`max-concurrent`/`category-cooldown-ms`).
- **Real Mapbox POIs react too**: tapping (or getting close to) an ordinary POI from the basemap
  itself (a real theatre, shop, church, school, ...) also summons a themed ghost — its `maki` icon
  id is mapped onto one of the 6 Halloween categories (see `src/maki-map.ts` and the
  `halloween-ping-<maki>` sound-layers in `sound-style-halloween.json`), not just the 9 fictional
  POIs in `src/poi-data.ts`. Both kinds of POI fire through the same `halloween-proximity` group
  (mirroring vanilla's `poi-proximity`, which also has a custom-layer source and a real-featureset
  source side by side), so the concurrency caps above apply across both together.
- **A continuous eerie ambient bed**: starts once "Enable audio" is pressed (`ambient` type).

No new audio was recorded for this demo — it reuses existing `sound-style-assets` files
(cemetery/castle/shop/religious/monument/information) re-themed as Halloween categories in
`sound-style-halloween.json`.

## Setup

1. Get a Mapbox access token (e.g. from a company account)
2. Copy `.env.local.example` to `.env.local` and set your token

   ```bash
   cp .env.local.example .env.local
   # Edit .env.local and set VITE_MAPBOX_ACCESS_TOKEN
   ```

3. Start the dev server

   ```bash
   pnpm --filter @sound-style/example-halloween dev
   ```

4. Open it in a browser and press "Enable audio" before interacting with it (browser autoplay
   policies don't allow sound without a user gesture).
