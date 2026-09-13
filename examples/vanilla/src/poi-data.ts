import type { FeatureCollection } from 'geojson';

/**
 * Dummy POIs for the POI-click-SE / screen-center POI-soundscape demo (arbitrary points around San
 * Francisco). `category` is used by the representative-POI-detection demo in the center rectangle
 * to play a different SE per kind — it must match a maki name that has a corresponding
 * `poi-ping-<category>` layer in the Style JSON. Any category with no matching layer silently
 * plays nothing (graceful degradation, not a bug).
 */
export const poiGeoJson: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Union Square', category: 'shop' },
      geometry: { type: 'Point', coordinates: [-122.4075, 37.788] },
    },
    {
      type: 'Feature',
      properties: { name: 'Ferry Building', category: 'landmark' },
      geometry: { type: 'Point', coordinates: [-122.3937, 37.7955] },
    },
    {
      type: 'Feature',
      properties: { name: 'Chinatown', category: 'restaurant' },
      geometry: { type: 'Point', coordinates: [-122.4058, 37.7941] },
    },
    {
      type: 'Feature',
      properties: { name: 'Yerba Buena Gardens', category: 'park' },
      geometry: { type: 'Point', coordinates: [-122.4014, 37.7845] },
    },
    {
      type: 'Feature',
      properties: { name: 'Grace Cathedral', category: 'place-of-worship' },
      geometry: { type: 'Point', coordinates: [-122.4103, 37.7924] },
    },
    {
      type: 'Feature',
      properties: { name: 'SFMOMA', category: 'art-gallery' },
      geometry: { type: 'Point', coordinates: [-122.4008, 37.7857] },
    },
    {
      type: 'Feature',
      properties: { name: 'Lowell High School', category: 'college' },
      geometry: { type: 'Point', coordinates: [-122.4863, 37.7377] },
    },
  ],
};
