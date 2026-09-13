import { describe, expect, it } from 'vitest';
import { ExpressionEvaluationError, ExpressionEvaluator } from './expression-evaluator.js';

const evaluator = new ExpressionEvaluator({
  propertySpecs: {
    'sound-volume': { type: 'number', default: 1, minimum: 0, maximum: 1 },
  },
});

describe('ExpressionEvaluator', () => {
  it('evaluates a constant value regardless of context', () => {
    const compiled = evaluator.createPropertyExpression<number>('sound-volume', 0.5);
    expect(compiled.isExpression).toBe(false);
    expect(compiled.evaluate({ zoom: 0 })).toBe(0.5);
    expect(compiled.evaluate({ zoom: 20 })).toBe(0.5);
  });

  it('falls back to the property spec default when no value is given', () => {
    const compiled = evaluator.createPropertyExpression<number>('sound-volume', undefined);
    expect(compiled.evaluate({ zoom: 0 })).toBe(1);
  });

  it('evaluates a zoom-driven interpolate expression', () => {
    const compiled = evaluator.createPropertyExpression<number>('sound-volume', [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0,
      16,
      1,
    ]);
    expect(compiled.isExpression).toBe(true);
    expect(compiled.evaluate({ zoom: 10 })).toBeCloseTo(0);
    expect(compiled.evaluate({ zoom: 13 })).toBeCloseTo(0.5);
    expect(compiled.evaluate({ zoom: 16 })).toBeCloseTo(1);
  });

  it('evaluates a feature-property-driven expression', () => {
    const compiled = evaluator.createPropertyExpression<number>('sound-volume', [
      'interpolate',
      ['linear'],
      ['get', 'congestion'],
      0,
      0,
      1,
      1,
    ]);
    expect(
      compiled.evaluate({ zoom: 0, feature: { properties: { congestion: 0.75 } } }),
    ).toBeCloseTo(0.75);
  });

  it('throws ExpressionEvaluationError for an unknown property name', () => {
    expect(() => evaluator.createPropertyExpression('not-a-property', 1)).toThrow(
      ExpressionEvaluationError,
    );
  });

  it('throws ExpressionEvaluationError for a value of the wrong type', () => {
    expect(() => evaluator.createPropertyExpression('sound-volume', 'loud' as never)).toThrow(
      ExpressionEvaluationError,
    );
  });
});
