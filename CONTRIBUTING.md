# Contributing

Thanks for your interest in contributing to sound-style. This document covers the minimal ground
rules for development.

_日本語版: [CONTRIBUTING-ja.md](./CONTRIBUTING-ja.md)_

## Setup

```bash
pnpm install
```

Requires Node.js 20+ and pnpm (see the `packageManager` field).

## Development flow

```bash
pnpm build       # build all packages (tsup / vite)
pnpm test        # run unit tests across all packages (vitest)
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit for each package
```

A husky pre-commit hook runs the four commands above (lint → typecheck → test → build)
automatically on `git commit`. Make sure they all pass before committing.

## Commit messages

We don't enforce a strict convention like Conventional Commits, but please write 1-2 sentences
that convey *why* a change was needed, not just *what* changed.

## Changing package dependencies

Add new dependency versions to the `catalog` in `pnpm-workspace.yaml` rather than to individual
`package.json` files, and reference them from each `package.json` as `"catalog:"` (for centralized
version management).
