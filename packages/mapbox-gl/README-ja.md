# @sound-style/mapbox-gl

[`@sound-style/core`](../core) の `SoundStyleEngine` を Mapbox GL JS の地図に自動連携させるバインディングです。
クリック・ホバー・ズーム・`queryRenderedFeatures` によるデータ密度集計・エリア判定を、
`SoundStyleEngine` への呼び出し（`trigger` / `updateContext` / `setActiveState`）に変換します。

_English: [README.md](./README.md)_

## インストール

```bash
npm install @sound-style/core @sound-style/mapbox-gl mapbox-gl
```

## 使い方

```ts
import mapboxgl from 'mapbox-gl';
import { SoundStyleEngine, validateSoundStyle } from '@sound-style/core';
import { MapboxSoundAdapter } from '@sound-style/mapbox-gl';

const map = new mapboxgl.Map({ container: 'map', style: '...' });

map.on('load', async () => {
  // 音源のロードは必ずユーザー操作（クリック等）を起点にAudioContextをresumeしてから行う
  const audioContext = new AudioContext();
  await audioContext.resume();

  const engine = new SoundStyleEngine({ audioContext });
  await engine.load(validateSoundStyle(mySoundStyle));

  // engine.load()より後に生成すること（ロード済みレイヤーを列挙してイベントを配線するため）
  const adapter = new MapboxSoundAdapter(map, engine);

  // 不要になったら
  // adapter.destroy();
});
```

`sound-layer.type` ごとに以下のように配線されます。

- **`event`**: `layout['sound-trigger']` が `click`/`mouseenter`/`mouseleave` の場合は
  `target-layer` 上のフィーチャーイベントを購読。`zoom-in`/`zoom-out` の場合は `zoomend` を監視。
- **`ambient`**: `moveend`（`updateDuringMove: true` 指定時は `move` 中も）で
  `target-layer` 上のフィーチャーを `queryRenderedFeatures` し、数値プロパティの平均値を
  合成した仮想フィーチャーとして `updateContext()` に渡す。`target-layer` 省略時はズームのみで駆動。
- **`bgm-state`**: `moveend` でカメラ中心点を含む `target-layer` 上のフィーチャーを取得し、
  `layout['sound-state-property']` の値が変化したら `setActiveState()` を呼ぶ。

## オプション

```ts
new MapboxSoundAdapter(map, engine, {
  // trueにするとambient型のqueryRenderedFeaturesを'move'中も実行する（コスト増に注意）
  updateDuringMove: false,
});
```

## Utility API

`MapboxSoundAdapter`の宣言的な自動配線ではカバーしきれない、アプリ独自の配線（半径指定の範囲検出、
複数レイヤー跨ぎの判定など）向けに、以下のユーティリティも公開しています。

- **`queryFeaturesWithinRadius(map, { radiusMeters, layers | target, filter?, center? })`**:
  地図中心（または`center`指定点）から実距離`radiusMeters`以内のフィーチャーを検出し、
  `{ feature, lngLat, distanceMeters }[]`を近い順に返す。
- **`getFeatureLngLat(feature)`** / **`metersPerPixelAtLat(lat, zoom)`**: 上記が内部で使う
  地理計算のプリミティブ。UIオーバーレイのサイズ計算など単独でも有用なため公開。
- **`addTerrainQueryLayers(map)`** / **`addCountryQueryLayers(map)`**: Mapbox Standardスタイルの
  水域/土地被覆/国境はfeaturesetとして公開されていないため、classic版タイルセットを非表示レイヤーとして
  追加する迂回策をヘルパー化したもの。呼び出しタイミング・重複追加の回避は呼び出し側の責務。
  レイヤーIDは`TERRAIN_QUERY_LAYER_IDS` / `COUNTRY_QUERY_LAYER_ID`として公開。
- **`findMatchingLayerByPrefix(engine, prefix, feature)`**: `<prefix><カテゴリ名>`という命名の
  レイヤー群（例: `poi-ping-<category>`）に対し、`feature`がどのレイヤーの`filter`にマッチするかを
  判定し、マッチしたレイヤーIDから`prefix`を除いた部分を返す。class/groupタクソノミー→カテゴリの
  変換をsound-style JSON側の`filter`一箇所にまとめ、アプリ側で二重管理しないために使う。
