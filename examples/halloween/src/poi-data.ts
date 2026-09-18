import type { FeatureCollection } from 'geojson';

/**
 * Fictional Halloween POIs (arbitrary points around San Francisco, same default map area as the
 * vanilla example). `category` must match one of the `halloween-ping-<category>` sound-layer ids
 * in sound-style-halloween.json — any category with no matching layer silently plays nothing.
 */
export const poiGeoJson: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Shadow Hollow Cemetery', category: 'cemetery' },
      geometry: { type: 'Point', coordinates: [-122.4075, 37.788] },
    },
    {
      type: 'Feature',
      properties: { name: 'Ravenspire Manor', category: 'haunted-mansion' },
      geometry: { type: 'Point', coordinates: [-122.3937, 37.7955] },
    },
    {
      type: 'Feature',
      properties: { name: "Old Wick Curiosities", category: 'witch-shop' },
      geometry: { type: 'Point', coordinates: [-122.4058, 37.7941] },
    },
    {
      type: 'Feature',
      properties: { name: "St. Whisper's Chapel", category: 'church' },
      geometry: { type: 'Point', coordinates: [-122.4103, 37.7924] },
    },
    {
      type: 'Feature',
      properties: { name: 'The Forgotten Obelisk', category: 'monument' },
      geometry: { type: 'Point', coordinates: [-122.4014, 37.7845] },
    },
    {
      type: 'Feature',
      properties: { name: 'Lantern Watch Post', category: 'info-booth' },
      geometry: { type: 'Point', coordinates: [-122.4008, 37.7857] },
    },
    {
      type: 'Feature',
      properties: { name: 'Bonevale Cemetery', category: 'cemetery' },
      geometry: { type: 'Point', coordinates: [-122.412, 37.7898] },
    },
    {
      type: 'Feature',
      properties: { name: 'Crowfeather Estate', category: 'haunted-mansion' },
      geometry: { type: 'Point', coordinates: [-122.4165, 37.7862] },
    },
    {
      type: 'Feature',
      properties: { name: 'Wraith & Wick Apothecary', category: 'witch-shop' },
      geometry: { type: 'Point', coordinates: [-122.398, 37.7908] },
    },
  ],
};
