# axi-sdk-js release validation

Validated target `7f62da038241362e320d31dfe99433a8acda1172` against base `d6560fca9e6dd8fdd9672bb8fa49e740ca86658f`.

## Scope

The target diff only changes `AGENTS.md`, adding the maintainer runbook for publishing `axi-sdk-js` through release-please.

## Local SDK checks

Command:

```sh
pnpm --dir packages/axi-sdk-js test
```

Result:

```text
Test Files  4 passed (4)
Tests  115 passed (115)
test/update.test.ts (53 tests)
```

Command:

```sh
pnpm --dir packages/axi-sdk-js run build
```

Result:

```text
$ tsc -p tsconfig.json
```

The generated `packages/axi-sdk-js/dist` contained `dist/update.js`, `dist/update.d.ts`, `dist/cli.js`, and `dist/index.js`.
`dist/cli.js` included `RESERVED_COMMANDS = ["update"]` and the built-in `runUpdate` dispatch.

## Built SDK CLI smoke checks

The built SDK was exercised through a minimal `runAxiCli` consumer.

Command shape:

```sh
node --input-type=module -e 'import { runAxiCli } from "./packages/axi-sdk-js/dist/index.js"; ...'
```

Top-level help exposed the inherited built-in:

```text
commands:
  issue
"built-in":
  update: Upgrade `toy-axi` to the latest published version
  "update --check": Report current vs latest without installing
```

`toy-axi update --help` rendered the built-in command help:

```text
command: update
description: Upgrade `toy-axi` to the latest published npm version
flags:
  "--check": Report current vs latest and exit without installing
examples[2]: toy-axi update,toy-axi update --check
```

`toy-axi update --check` queried npm without installing:

```text
update:
  package: axi-sdk-js
  current: 0.1.7
  latest: 0.1.8
  available: true
help[1]: Run `toy-axi update` to upgrade
```

## Public npm state

Command:

```sh
npm view axi-sdk-js version dist-tags.latest
```

Result:

```text
version = '0.1.8'
dist-tags.latest = '0.1.8'
```

Command:

```sh
npm pack --dry-run --json axi-sdk-js@0.1.8
```

Selected result:

```text
id: axi-sdk-js@0.1.8
version: 0.1.8
files:
  dist/cli.d.ts
  dist/cli.js
  dist/index.d.ts
  dist/index.js
  dist/update.d.ts
  dist/update.js
```

## GitHub release path state

Command:

```sh
gh-axi pr view 61 --full
```

Selected result:

```text
number: 61
title: chore(main): release axi-sdk-js 0.1.8
state: merged
author: app/github-actions
merged: 2026-06-27T03:53:49Z
body includes: This PR was generated with Release Please
body includes: axi-sdk-js: add built-in self-update command (#60)
```

Command:

```sh
gh-axi release view axi-sdk-js-v0.1.8 --full
```

Selected result:

```text
tag: axi-sdk-js-v0.1.8
name: axi-sdk-js: v0.1.8
author: github-actions[bot]
body includes: axi-sdk-js: add built-in self-update command (#60)
```

Command:

```sh
gh-axi run list --workflow axi-sdk-js-release-please.yml --branch main --limit 5
```

Selected result:

```text
title: chore(main): release axi-sdk-js 0.1.8 (#61)
status: completed
conclusion: success
workflow: axi-sdk-js-release-please
branch: main
event: push
```
