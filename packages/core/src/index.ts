export type {
  AssetLoadStrategy,
  ExpressionSpecification,
  PropertyValueSpecification,
  SingleSoundSource,
  AudioSpriteClipDefinition,
  AudioSpriteSoundSource,
  SoundSourceSpecification,
  SoundTrigger,
  SoundLayerLayoutCommon,
  TargetFeaturesetSpecification,
  EventLayout,
  AmbientLayout,
  BgmStateLayout,
  SoundLayerLayout,
  SoundLayerPaint,
  EventSoundLayer,
  AmbientSoundLayer,
  BgmStateSoundLayer,
  SoundLayerSpecification,
  BgmPriorityQueryDimension,
  BgmPriorityZoomDimension,
  BgmPriorityConfigPropertyDimension,
  BgmPriorityDimension,
  BgmPriorityTierMatchValue,
  BgmPriorityTier,
  BgmPriorityGroup,
  ProximityPropertySource,
  ProximityLayerPrefixSource,
  ProximitySource,
  ProximityTriggerGroup,
  SoundStyleSpecification,
} from './types.js';

export { validateSoundStyle, SoundStyleValidationError } from './validate.js';

export type {
  AssetKind,
  AssetLoadState,
  AssetManagerOptions,
  ClipRange,
  StreamingHandle,
} from './asset-manager.js';
export { AssetLoadError, AssetManager, resolveAssetLoadStrategy } from './asset-manager.js';

export type {
  EvaluationContext,
  CompiledPropertyExpression,
  PropertyValueSpec,
  ExpressionEvaluatorOptions,
} from './expression-evaluator.js';
export { ExpressionEvaluator, ExpressionEvaluationError } from './expression-evaluator.js';

export type { SoundCategory, SoundStyleEngineEvent, SoundStyleEngineOptions, TriggerMeta } from './engine.js';
export { SoundStyleEngine } from './engine.js';
