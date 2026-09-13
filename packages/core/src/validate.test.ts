import { describe, expect, it } from 'vitest';
import { SoundStyleValidationError, validateSoundStyle } from './validate.js';
import type { SoundStyleSpecification } from './types.js';

const validStyle: SoundStyleSpecification = {
  version: 1,
  name: 'test-style',
  sources: {
    'poi-sfx': {
      type: 'audio-sprite',
      url: '/audio/poi-sfx.mp3',
      sprite: {
        select: { start: 0, end: 0.4 },
      },
    },
    'traffic-noise': {
      type: 'single',
      url: '/audio/traffic-loop.mp3',
      loop: true,
    },
  },
  'sound-layers': [
    {
      id: 'poi-click-sfx',
      type: 'event',
      source: 'poi-sfx',
      'sound-clip': 'select',
      'target-layer': 'poi-symbols',
      layout: { 'sound-trigger': 'click' },
      paint: { 'sound-volume': 0.8 },
    },
    {
      id: 'traffic-ambient',
      type: 'ambient',
      source: 'traffic-noise',
      'target-layer': 'traffic-lines',
      paint: {
        'sound-volume': ['interpolate', ['linear'], ['get', 'congestion'], 0, 0, 1, 1],
      },
    },
  ],
};

describe('validateSoundStyle', () => {
  it('accepts a well-formed sound-style document', () => {
    expect(validateSoundStyle(validStyle)).toEqual(validStyle);
  });

  it('rejects a document missing required top-level properties', () => {
    const { sources: _sources, ...withoutSources } = validStyle;
    expect(() => validateSoundStyle(withoutSources)).toThrow(SoundStyleValidationError);
  });

  it('rejects an unknown sound-layer type', () => {
    const invalid = {
      ...validStyle,
      'sound-layers': [
        {
          id: 'bad-layer',
          type: 'not-a-real-type',
          source: 'poi-sfx',
        },
      ],
    };
    expect(() => validateSoundStyle(invalid)).toThrow(SoundStyleValidationError);
  });

  it('rejects an event layer missing the required sound-trigger', () => {
    const invalid = {
      ...validStyle,
      'sound-layers': [
        {
          id: 'poi-click-sfx',
          type: 'event',
          source: 'poi-sfx',
          layout: {},
        },
      ],
    };
    expect(() => validateSoundStyle(invalid)).toThrow(SoundStyleValidationError);
  });

  it('rejects unknown properties (additionalProperties: false)', () => {
    const invalid = { ...validStyle, extraneous: true };
    expect(() => validateSoundStyle(invalid)).toThrow(SoundStyleValidationError);
  });
});
