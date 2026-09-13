# @sound-style/core

Web Audio APIを操作する、フレームワーク非依存の宣言的音響エンジンです。
Mapbox GL JSには依存しません（GL JSとの連携は [`@sound-style/mapbox-gl`](../mapbox-gl) が担当します）。

_English: [README.md](./README.md)_

## インストール

```bash
npm install @sound-style/core
```

## 使い方

```ts
import { SoundStyleEngine, validateSoundStyle } from '@sound-style/core';

const style = validateSoundStyle({
  version: 1,
  sources: {
    'poi-sfx': {
      type: 'audio-sprite',
      url: '/audio/poi-sfx.mp3',
      sprite: { select: { start: 0, end: 0.4 } },
    },
  },
  'sound-layers': [
    {
      id: 'poi-click-sfx',
      type: 'event',
      source: 'poi-sfx',
      'sound-clip': 'select',
      layout: { 'sound-trigger': 'click' },
      paint: { 'sound-volume': 0.8 },
    },
  ],
});

// AudioContextの生成/resumeはブラウザの自動再生ポリシー上、
// ユーザー操作（クリック等）を起点に行う必要があります。
const audioContext = new AudioContext();
await audioContext.resume();

const engine = new SoundStyleEngine({ audioContext });
engine.on('error', (e) => console.error(e.layerId, e.error));
await engine.load(style);

// event型レイヤーの単発再生
engine.trigger('poi-click-sfx');
```

### `sound-layers` の3タイプ

- **`event`**: `engine.trigger(layerId, context?)` で単発再生する効果音（POIクリック等）
- **`ambient`**: `engine.updateContext(layerId, context)` を継続的に呼び出し、音量・ピッチ等を
  ズームやフィーチャープロパティに応じて連続的に変化させる環境音
- **`bgm-state`**: `engine.setActiveState(layerId, stateKey)` でアクティブな状態を切り替え、
  `paint['sound-fade-duration']` に従ってクロスフェードするBGM

いずれもMapbox GL JSと自前で連携する場合は上記APIを直接呼び出してください。
Mapbox GL JSのマップイベントと自動連携させたい場合は [`@sound-style/mapbox-gl`](../mapbox-gl) を使います。

### `sound-style.json` のスキーマ

型定義は [`src/types.ts`](./src/types.ts)、JSON Schema（Draft-07）は
[`schema/sound-style.schema.json`](./schema/sound-style.schema.json) にあります。

`validateSoundStyle()` はこのJSON Schemaに基づいてバリデーションを行い、
不正な場合は `SoundStyleValidationError` を投げます。

## 主要API

| API | 説明 |
|---|---|
| `SoundStyleEngine` | スタイルドキュメントの読み込み・音響グラフの管理・再生制御 |
| `AssetManager` | 音源のfetch/decode/キャッシュ、audio-spriteのクリップ範囲解決（BGMは`<audio>`要素で全体デコードせずストリーミング再生） |
| `ExpressionEvaluator` | Mapbox Expression（`interpolate`/`match`/`get`等）のコンパイル・評価 |
| `validateSoundStyle()` | `sound-style.json` のスキーマ検証 |
