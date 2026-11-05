# 23. Root nx.json to anchor the Nx workspace root

Date: 2026-11-05

## Status

Accepted

## Decision

Add a root `nx.json` whose only purpose is to stop Nx's search for the workspace root at this repository's root. It also sets four keys so that Nx behaves as it did when the repository had no `nx.json`:

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "cacheDirectory": "node_modules/.cache/nx",
  "useDaemonProcess": false,
  "pluginsConfig": {
    "@nx/js": {
      "analyzePackageJson": true,
      "analyzeSourceFiles": false,
      "analyzeLockfile": false,
      "projectsAffectedByDependencyUpdates": "all"
    }
  }
}
```

It defines no `targetDefaults`, `targetDependencies` or `plugins`. `.nx/` is added to `.gitignore`.

## Context

- Lerna 8 runs tasks through Nx 20 (Nx 20.8.4 at the time of writing). Nx finds the workspace root by walking up from the current directory (`workspaceRootInner` in `node_modules/nx/src/utils/workspace-root.js`). It stops at the first directory that contains `nx.json`. With no `nx.json` it keeps walking past every directory that contains `node_modules/nx` and returns the outermost one.
- Claude Code worktrees live at `.claude/worktrees/<name>/`, inside the main checkout. From a worktree, root `yarn lint`, `yarn test`, `yarn lerna run ...` and the pre-commit hook therefore ran the main checkout's packages. Observed: `app` reported 109 tests from a branch that had 116, and lint errors on that branch went unreported. Setting `NX_WORKSPACE_ROOT_PATH` per command worked but depended on every session remembering it.
- Nx special-cases "has `lerna.json` but no `nx.json`". A bare `{}` would have fixed the root but also changed four other things (measured from a worktree with a script that dumps Nx's resolved settings, project graph and Lerna-style task graphs):

  | Setting                              | No `nx.json`                            | Bare `{}`                                   | This `nx.json`                              |
  | ------------------------------------ | --------------------------------------- | ------------------------------------------- | ------------------------------------------- |
  | Task cache directory                 | `node_modules/.cache/nx`                | `.nx/cache`                                 | `node_modules/.cache/nx` (`cacheDirectory`) |
  | Nx daemon                            | off                                     | on                                          | off (`useDaemonProcess: false`)             |
  | Lockfile analysis                    | off, 0 npm nodes                        | on, 2,612 npm nodes parsed from `yarn.lock` | off (`pluginsConfig`)                       |
  | Workspace data (project graph cache) | `node_modules/.cache/nx-workspace-data` | `.nx/workspace-data`                        | `.nx/workspace-data`                        |

  Only an environment variable (`NX_WORKSPACE_DATA_DIRECTORY`) can move the workspace data directory, so it moves and is git-ignored. It holds regenerable cache files only.

- Lerna's `run` command keeps its own ordering (toposort, `--parallel`, `--sort`) unless `nx.json` defines `targetDefaults` or `targetDependencies` (`prepNxOptions` in `node_modules/lerna/dist/commands/run/index.js`). This file defines neither.
- Alternatives considered:
  - `NX_WORKSPACE_ROOT_PATH` in the root scripts: does not cover direct `yarn lerna run` calls, and every entry point would need it.
  - An empty file named `nx` at the root: it also stops the search, with no other effect, but Nx uses that name for its wrapper script (`nx init` in non-JavaScript repositories), so the file would mislead readers.

## Consequences

- Root commands and the pre-commit hook run against the checkout they are started from, including worktrees nested in the main checkout.
- With the four keys, the project graph (14 projects, their targets and internal dependencies) and the task graphs Lerna builds for `lint`, `test`, `build` and `precommit` were identical with and without the file.
- Nx's own `postinstall` step builds the project graph during `yarn install` when `nx.json` exists. It swallows its errors, so it can slow a fresh install slightly but not fail it.
- A worktree on a branch that predates this file still resolves to the main checkout once the main checkout has `nx.json`, because the search stops at the first `nx.json` it finds. Merge `trunk` into such a branch, or set `NX_WORKSPACE_ROOT_PATH`.
- Adding `targetDefaults` later (for example to turn on Nx caching) makes Lerna hand ordering to Nx and ignore `--parallel` and `--sort`. That needs its own ADR.
- On an Nx upgrade, re-check the special cases this file pins. They live in `src/utils/cache-directory.js`, `src/daemon/client/client.js` and `src/plugins/js/utils/config.js` under `node_modules/nx`.
- The hook script itself is still chosen by git's `core.hooksPath`; this decision does not change that.
