import { expression as mapboxExpression } from '@mapbox/mapbox-gl-style-spec';
import type { PropertyExpressionSpecification, StylePropertySpecification } from '@mapbox/mapbox-gl-style-spec';
import type { ExpressionSpecification, PropertyValueSpecification } from './types.js';

export interface EvaluationContext {
  /** Current zoom level */
  zoom: number;
  /** The target feature on the target layer (e.g. during event/ambient aggregation) */
  feature?: {
    id?: string | number;
    properties: Record<string, unknown>;
    /**
     * The feature's location info (equivalent to a GeoJSON Geometry). Not used during
     * Expression evaluation — it is simply passed through as-is if the caller of
     * engine.trigger() (MapboxSoundAdapter) happens to know it.
     * It exists so that application code can learn "where did this sound play"
     * from the `layer:play`/`layer:stop` events (e.g. to show an annotation on the map).
     */
    geometry?: unknown;
  };
  /** feature-state (e.g. hover state or aggregated density) */
  featureState?: Record<string, unknown>;
}

/** A property value that has been parsed into an evaluable state */
export interface CompiledPropertyExpression<T> {
  readonly isExpression: boolean;
  evaluate(context: EvaluationContext): T;
}

export interface PropertyValueSpec {
  type: 'number' | 'boolean' | 'string';
  default: number | boolean | string;
  minimum?: number;
  maximum?: number;
}

export interface ExpressionEvaluatorOptions {
  /** Spec defining the type, default value, and value range for each paint property (e.g. sound-volume: number 0-1) */
  propertySpecs: Record<string, PropertyValueSpec>;
}

export class ExpressionEvaluationError extends Error {
  constructor(
    message: string,
    public readonly propertyName: string,
  ) {
    super(message);
    this.name = 'ExpressionEvaluationError';
  }
}

// Allow zoom/feature-property as inputs, and permit the use of interpolate/step.
// (@mapbox/mapbox-gl-style-spec does not allow zoom/feature expressions from
// property-type: 'data-driven' alone — they must be explicitly declared in
// expression.parameters.)
const DATA_DRIVEN_EXPRESSION_SUPPORT: PropertyExpressionSpecification = {
  interpolated: true,
  parameters: ['zoom', 'feature'],
};

function toStylePropertySpecification(spec: PropertyValueSpec): StylePropertySpecification {
  if (spec.type === 'number') {
    return {
      type: 'number',
      'property-type': 'data-driven',
      transition: false,
      default: spec.default as number,
      minimum: spec.minimum,
      maximum: spec.maximum,
      expression: DATA_DRIVEN_EXPRESSION_SUPPORT,
    };
  }
  if (spec.type === 'boolean') {
    return {
      type: 'boolean',
      'property-type': 'data-driven',
      transition: false,
      default: spec.default as boolean,
      expression: DATA_DRIVEN_EXPRESSION_SUPPORT,
    };
  }
  return {
    type: 'string',
    'property-type': 'data-driven',
    transition: false,
    default: spec.default as string,
    expression: DATA_DRIVEN_EXPRESSION_SUPPORT,
  };
}

export class ExpressionEvaluator {
  private readonly propertySpecs: Record<string, PropertyValueSpec>;

  constructor(options: ExpressionEvaluatorOptions) {
    this.propertySpecs = options.propertySpecs;
  }

  /** Accepts either a constant value or an Expression array, and compiles it into an evaluable form */
  createPropertyExpression<T>(
    propertyName: string,
    rawValue: PropertyValueSpecification<T> | undefined,
  ): CompiledPropertyExpression<T> {
    const spec = this.propertySpecs[propertyName];
    if (!spec) {
      throw new ExpressionEvaluationError(`Unknown paint property: ${propertyName}`, propertyName);
    }
    const value = rawValue === undefined ? spec.default : rawValue;
    const styleSpec = toStylePropertySpecification(spec);
    const result = mapboxExpression.createPropertyExpression(value, styleSpec);
    if (result.result === 'error') {
      const message = result.value.map((e) => e.message).join('; ');
      throw new ExpressionEvaluationError(
        `Invalid value for "${propertyName}": ${message}`,
        propertyName,
      );
    }
    const compiled = result.value;
    return {
      isExpression: compiled.kind !== 'constant',
      evaluate: (context: EvaluationContext): T =>
        compiled.evaluate(
          { zoom: context.zoom },
          context.feature && {
            type: 'Unknown',
            id: context.feature.id,
            properties: context.feature.properties,
          },
          context.featureState,
        ) as T,
    };
  }

  /** Determines whether a value is an Expression array ([operator, ...args]) */
  static isExpression(value: unknown): value is ExpressionSpecification {
    return mapboxExpression.isExpression(value);
  }
}
