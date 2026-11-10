# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this repository is

A fork of [cloud-carbon-footprint/cloud-carbon-footprint](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint) (Apache-2.0, Thoughtworks) owned by Ben de Mora, being extended into a localised, time-resolved cloud carbon estimator with a pluggable grid-intensity source layer, provenance on every estimate, a published factor table, calibration against provider reports, and an export for FinOps tooling.

Read these before any non-trivial change:

- `docs/design/2026-11-localised-time-resolved-carbon-estimation.md`: the approved design, the phase plan (section 12) and the verification backlog (section 14). Work in phase order; each phase lists its acceptance criteria. Section 12 ends with the current status and the agreed order of work, which is where to check what is done and what comes next.
- `.adr/0022-grid_intensity_source_layer.md`: the headline decision. New architectural decisions get a new ADR in `.adr/` (numbered, same format).
- `microsite/docs/HowItWorks/Methodology.md`: the estimation model this fork keeps.

## Toolchain

- Node 24 or later (CI runs 24.x). Yarn 4.12.0 is vendored at `.yarn/releases/yarn-4.12.0.cjs` and selected by `yarnPath` in `.yarnrc.yml`; any `yarn` shim (Corepack or classic) runs it. TypeScript 5.5.4 (pinned via `resolutions`), Lerna 8 with Nx, Jest 29 with ts-jest, ESLint 8/10, Prettier 3 (no semicolons, single quotes, trailing commas; see `.prettierrc.json`).
- `.yarnrc.yml` sets `supportedArchitectures` so one `node_modules` works from macOS and Linux on arm64 (nx native binaries for both are fetched). Keep that setting.
- `nx.json` exists only to stop Nx's workspace-root search at this checkout, so root commands and the hook in a worktree under `.claude/worktrees/` run that worktree's packages. Its other keys keep Nx as it was without the file (cache in `node_modules/.cache/nx`, no daemon, no lockfile analysis). Do not add `targetDefaults` without an ADR: Lerna then hands task ordering to Nx. See `.adr/0023-nx_json_workspace_root_anchor.md`.
- `react-scripts` is a Yarn `patch:` dependency (`.yarn/patches/react-scripts-npm-5.0.1-d06bd2d5ad.patch`) so the client dev server starts on machines without an RFC 1918 address. If you change the patch, update its checksum in `.talismanrc`.

## Commands (run from the repository root)

```sh
yarn install --immutable        # fails if yarn.lock would change; that is intended
yarn lint                       # all packages (about 40 s)
yarn test                       # all packages, with coverage and --runInBand (about 3 to 4 min)
yarn lerna run build            # backend packages (prepack rewrites package.json, postpack restores it)
yarn workspace @cloud-carbon-footprint/client build:app
yarn workspace @cloud-carbon-footprint/<pkg> test
yarn start-with-mock-data       # client on :3000 with a json-server stub on :4000
yarn workspace @cloud-carbon-footprint/integration-tests headless   # TestCafe e2e; starts client and API in TEST_MODE itself
```

Per-package coverage thresholds live in each `packages/<pkg>/jest.config.js` (client: the `jest` block in its `package.json`). Do not lower them; new packages start at 90 % statements and branches.

## Git process

- Never commit to `trunk`. Branch from `trunk`, open a pull request against `trunk` on the fork (`bendemora/cloud-carbon-footprint`), merge only when CI is green and the owner has reviewed.
- `upstream` is `cloud-carbon-footprint/cloud-carbon-footprint`. Sync `trunk` from `upstream/trunk` deliberately, on its own PR, and never force-push `trunk`.
- Commit messages: imperative subject under 72 characters with a conventional prefix (`feat`, `fix`, `chore`, `ci`, `docs`, `test`); body explains why and what was verified. Include a changeset (`yarn changeset`) for every published package whose behaviour changes.
- Writing style for docs and commit messages: plain English, no em dashes, no "genuinely" or "honestly", state what was verified and flag what is inferred.

## The pre-commit hook (husky, `.husky/pre-commit`)

It runs on every commit and is slow by design:

1. `scripts/copyright_check.sh`, then `scripts/branch_warning.sh` (POSIX sh; answers yes automatically when non-interactive).
2. `scripts/talisman_check.sh`: Talisman secrets scanning is mandatory. It uses `$TALISMAN_HOME/talisman_hook_script` if set, otherwise a `talisman` binary on `PATH` (`brew install talisman` on macOS). A missing Talisman fails the commit. A false positive is handled by adding the file and its checksum to `.talismanrc` (Talisman prints the exact lines), never by `--no-verify`.
3. If any file under `packages/` is staged: `yarn lerna run precommit --stream`, which runs lint-staged plus the full unit tests of every package and the TestCafe end-to-end suite. Expect 6 to 8 minutes; it needs Google Chrome. On macOS, TestCafe also needs the Screen Recording permission for the terminal that runs it.

Do not bypass the hook. If a commit must be split to keep the hook's run meaningful, split it.

## Where things are

- `packages/core`: estimators and the energy model constants types. `packages/common`: config (`Config.ts`, env vars via `getEnvVar`), result types, the legacy `EmissionsFactors.ts`. `packages/app`: `App.getCostAndEstimates`, cache decorator and managers. `packages/aws|gcp|azure|ali|on-premise`: provider usage sources and constants. `packages/api`: Express routes under `/api`. `packages/cli`: commands as `package.json` scripts. `packages/client`: Create React App UI. `packages/integration-tests`: TestCafe.
- `packages/grid-intensity`: the grid intensity source layer (design section 6): interfaces, sources, the resolver, the stores and the `resolveEmissionsFactors` adapter that the provider packages call.
- Planned: `packages/provider-reports` (section 10).
- Test fixtures live in each package's `src/__tests__/fixtures/`. External HTTP is never called in tests; mock `global.fetch` as `packages/common/src/__tests__/EmissionsFactors.test.ts` does, with recorded fixtures.

## Data and secrets

- Never commit tokens, `.env` files, cache files (`estimates.cache.*.json`), grid-intensity store files, or any dataset obtained under a commercial or non-commercial licence. The repository contains code, static reference constants and recorded test fixtures only.
- Every data source has a licence declaration in code and an entry in `DATA_SOURCES.md` (phase 8). Attribution strings are part of the output, not an afterthought.

## Environment notes

- The project owner works from macOS (Apple Silicon, Homebrew Node, Corepack-provided `yarn`, Talisman via Homebrew) and from a Linux arm64 shell mounted on the same checkout. Both must keep working; that is why the multi-arch Yarn setting exists.
- Chrome is required for the end-to-end suite in both environments.
