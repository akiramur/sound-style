# Contributing

sound-styleへの貢献ありがとうございます。このドキュメントは開発時の最低限の決まりごとです。

_English: [CONTRIBUTING.md](./CONTRIBUTING.md)_

## セットアップ

```bash
pnpm install
```

Node.js 20以上、pnpmが必要です（`packageManager`フィールド参照）。

## 開発フロー

```bash
pnpm build       # 全パッケージをビルド（tsup / vite）
pnpm test        # 全パッケージのユニットテストを実行（vitest）
pnpm lint        # ESLint
pnpm typecheck   # 各パッケージのtsc --noEmit
```

`git commit` 時にはhuskyのpre-commitフックが上記4つ（lint → typecheck → test → build）を
自動実行します。コミット前にすべて通ることを確認してください。

## コミットメッセージ

Conventional Commits等の厳密な規約は設けていませんが、「何を」ではなく「なぜ」その変更が
必要だったかが伝わる1〜2文を心がけてください。

## パッケージ構成の変更

新しい依存パッケージのバージョンは、個々の `package.json` ではなく
`pnpm-workspace.yaml` の `catalog` に追加し、各 `package.json` からは
`"catalog:"` を参照してください（バージョンの一元管理のため）。
