# sound-style

Mapbox GL JS の設計思想（Style Spec）に準拠した、Web / WebGIS 向けの宣言的音響管理エンジンです。
地図のカメラ移動・ズーム・POIタップ・エリアイン/アウト・データ密度の変化などに応じて鳴らす音を、
JSONによる宣言的な `sound-style.json` で定義し、コードを散らかさずにデータ駆動で制御します。

_English: [README.md](./README.md)_

```json
{
  "version": 1,
  "sources": {
    "poi-sfx": {
      "type": "audio-sprite",
      "url": "/audio/poi-sfx.mp3",
      "sprite": { "select": { "start": 0, "end": 0.4 } }
    }
  },
  "sound-layers": [
    {
      "id": "poi-click-sfx",
      "type": "event",
      "source": "poi-sfx",
      "sound-clip": "select",
      "target-layer": "poi-symbols",
      "layout": { "sound-trigger": "click" },
      "paint": { "sound-volume": 0.8 }
    }
  ]
}
```

## パッケージ構成

このリポジトリは pnpm workspaces によるモノレポです。

| パッケージ | 説明 |
|---|---|
| [`@sound-style/core`](./packages/core) | Web Audio APIの操作、`sound-style.json`のパース・検証、Mapbox Expressionの評価を行うフレームワーク非依存のコア |
| [`@sound-style/mapbox-gl`](./packages/mapbox-gl) | Mapbox GL JSのイベント（move, click, queryRenderedFeatures等）と自動連動するバインディング |
| [`examples/vanilla`](./examples/vanilla) | SDK利用者向けのクリーンな最小構成のサンプルアプリ（vanilla JS + Mapbox GL JS） |

## 開発

```bash
pnpm install
pnpm build       # 全パッケージをビルド
pnpm test        # 全パッケージのユニットテストを実行
pnpm lint        # ESLint
pnpm typecheck   # 型チェック
```

サンプルアプリを起動するには [`examples/vanilla/README.md`](./examples/vanilla/README.md) を参照してください。

## 免責事項

sound-styleは個人による独立したプロジェクトです。Mapboxと提携・公認された、あるいはMapboxが
公式にサポートするものではありません。「Mapbox」および「Mapbox GL JS」はMapbox, Inc.の商標です。

## ライセンス

[MIT](./LICENSE)
