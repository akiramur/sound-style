import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
// Embed the JSON into the bundle at build time (avoid fs access so this works in both the browser and Node).
import schemaJson from '../schema/sound-style.schema.json' with { type: 'json' };
import type { SoundStyleSpecification } from './types.js';

const schema = schemaJson as AnySchema;

export class SoundStyleValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ErrorObject[],
  ) {
    super(message);
    this.name = 'SoundStyleValidationError';
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn: ValidateFunction = ajv.compile(schema);

/**
 * Validates a plain sound-style.json object and, on success, returns it typed
 * as a SoundStyleSpecification. Throws a SoundStyleValidationError on failure.
 */
export function validateSoundStyle(input: unknown): SoundStyleSpecification {
  const valid = validateFn(input);
  if (!valid) {
    const errors = validateFn.errors ?? [];
    const message = errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
      .join('; ');
    throw new SoundStyleValidationError(`Invalid sound-style document: ${message}`, errors);
  }
  return input as SoundStyleSpecification;
}
