# 25. Refreshing cached estimates whose grid intensity can improve

Date: 2026-11-10

## Status

Accepted. Design section 12 puts the marker before the first live source, and the project owner asked on 2026-11-12 for that plan to be carried out. The marker (point 1 of the decision) is built in the pull request that changed this status. Replace and refresh (points 2 and 3) are not built yet. The implementation notes at the end record what was built.

## Decision

A cached period can be estimated again when its grid intensity was not the best the configuration can deliver. Three additions make that possible.

1. **A marker.** `Provenance` gains an optional `isProvisional` flag. The resolver sets it when the same configuration could give a better result later:
   - the period was only partly covered (data not published yet, a gap, or a period that runs beyond the latest data);
   - the source reports its points as preliminary (a forecast, or an estimate it will replace), through a new optional flag on `IntensityPoint`;
   - a source that is configured, acknowledged and mapped for the region was unavailable (a failed request or probe) and a lower-ranked source answered instead.

   A result is final when the best eligible source served the whole period with settled data, and also when only the static table can serve the region. The quality tier is unchanged by the marker.

2. **Replace.** Each cache manager gains an operation that replaces the cached rows of given periods and providers. `LOCAL` and `GCS` rewrite the cache file with the new periods in place of the old. `MONGODB` deletes the rows of those periods and providers, then inserts the new ones.
3. **Refresh.** `packages/app` gains a refresh operation that estimates cached periods in a date range again from billing data and replaces them, by default only the periods that hold provisional rows. It is a CLI command, and `export-dataset` (design section 11.2) runs it for the range it is about to write. Requests to `GET /footprint` never start it. The doctor command and the capabilities endpoint report how many cached periods are provisional.

Design section 6.2 stands: a source failure never aborts an estimation run. The fallback rows are cached with their real tier and the marker.

Once rows carry the fields of ADR 0024, the refresh gains a second mode that re-prices a row from its stored operational energy and embodied emissions, without reading billing data. It is meant for long histories, for example after a source is added.

## Context

Verified in the code on 2026-11-10 (trunk `a42b5ac6`):

- The `@cache()` decorator (`packages/app/src/Cache.ts`) asks the cache manager which dates of a request are missing and estimates only those. A date counts as cached when any result exists for it (`getMissingDates` in `packages/app/src/common/helpers.ts`, and its MongoDB equivalent in `MongoDbCacheManager.ts`). What the rows contain is not looked at.
- `ignoreCache=true` returns new estimates and does not write them to the cache.
- No cache manager can replace a period today. `LocalCacheManager` merges new results over cached ones for the same timestamp, but it is only ever given missing dates. `GoogleCloudCacheManager.setEstimates` appends the new results to the cached ones, and `MongoDbCacheManager.setEstimates` inserts rows, so writing a date twice would duplicate it in both.
- The tests of the decorator's missing-dates behaviour have been skipped upstream since 2022 (`describe.skip('populates missing dates')` in `packages/app/src/__tests__/Cache.test.ts`).
- Provenance says how good a row's intensity is (`qualityTier`, `isEstimated`), not whether it could be better later.

Why this needs deciding now:

- The resolver falls back when a source fails (design section 6.2) and estimates from partial data when a period is not fully published (the implementation notes under 6.2). Both are right for the run. With a cache that never looks again, one outage or one early run fixes tier C or D rows for good. It applies to every live source, starting with the first one in Phase 2. The Electricity Maps lookup the fork inherited avoided it only by stopping the run, and ADR 0026 has since removed that lookup.
- The same holds when the configuration improves. Adding a source, a credential or a licence acknowledgement does not touch periods that are already cached.
- How soon each open source publishes settled values is not verified yet (design section 14).

Alternatives considered:

- Stop the run when a source fails, as the Electricity Maps lookup did until ADR 0026 removed it. It protects the cache from failures only, gives up the availability rule in section 6.2, and does nothing for late data or a changed configuration.
- Do not cache a period that holds provisional rows. Every request would then read the billing data for those periods again. While a failure is remembered for the capability TTL (24 hours by default), each of those reads would end in the same fallback.
- Refresh on read, inside the decorator. A read would become slow and costly at times the caller cannot predict, because billing queries cost money on Athena and BigQuery. It can be added behind a setting once the explicit refresh has proved itself.
- Cache energy only and apply the intensity when rows are read. It removes the problem at its root, but it changes every reader of the cache, the MongoDB paging and the cost of a read, which is more than this programme should take on. Re-pricing from stored fields gets most of the benefit.

## Consequences

- `Provenance` and `IntensityPoint` each gain one optional flag. Rows cached before the marker count as final, so nothing is refreshed unless a date range is asked for with the option to include every period.
- The cache managers gain one operation each. The MongoDB replace is a delete followed by an insert, not a transaction: if it fails between the two, the period is missing from the cache and the next request estimates it again. The GCS manager stops appending without looking for the date. The local replace writes through a temporary file and a rename, which also closes the partial-write fault noted in PR #15.
- The skipped decorator tests are replaced by tests that run, covering missing dates and the replace path.
- A refresh costs one billing request per provider and run of adjacent periods, as seeding the cache does. Refreshing recent periods also picks up billing data that arrived late, which the cache never did before. That is a side effect, not a goal.
- An operator who never runs the refresh keeps provisional rows. They are labelled in the API and the export, and the doctor reports their number, so the gap is visible.
- Re-pricing, once ADR 0024 is in place, is exact for known usage. It is approximate for unknown-usage rows on AWS and Azure, whose inherited embodied share was priced at the first intensity. A refresh from billing data is exact for both.
- Hourly grouping (Phase 3) multiplies the number of periods. The refresh works on date ranges, so its shape does not change, but finding provisional periods in MongoDB then needs an index.

## Implementation notes

### The marker (2026-11-12)

- `Provenance.isProvisional` is `true` on a provisional result and absent otherwise. A final row and a row estimated before the marker existed therefore look the same, which is what the consequences above ask for.
- The resolver decides it from the sources it tried for the usage period, in the order it tried them (`mayServeMore` in `GridIntensityResolver.ts`). A source could serve more later when its settled points do not cover the whole period and either it could not be asked (its capability probe or a fetch failed), or the part that is missing lies at or after the start of its data. A result is provisional when that is true of the source that answered or of any source tried before it. Sources after the one that answered are not tried, so they do not count.
- Three cases are final that the decision does not spell out. A period that lies wholly before the start of a source's data: the source will never have it. A period that starts before a source's data and is covered from there on: it is partly covered, estimated and tier C, but nothing more will come. A source that is failing but already holds the whole period in the store.
- One case is provisional that the three bullets of point 1 do not name: a lower-ranked source covers the period while a higher-ranked one has only part of it, or nothing yet, without having failed. The decision's definition of a final result ("the best eligible source served the whole period with settled data") covers it.
- A gap in a source's history that never fills leaves its periods provisional for good, as point 1 accepts ("a gap"). A refresh will estimate them again each time it runs. The same holds for a source whose data ends in the past, a loaded file for example: every later period stays provisional while that source is configured.
- `IntensityPoint.isPreliminary` is the source's flag for a value it will replace. The resolver uses a preliminary point and marks the result. It keeps the point in memory for the capability TTL, in the store it already keeps for sources with session retention, so a run does not ask for it again. It never writes one to the configured store, so a later run fetches the period again. This settles the question the NESO spike raised in its section 4.6: a stored preliminary point would never have been fetched again.
- When no source can serve a region and the adapter falls back to the provider's static table, the fallback row is provisional if a configured source could serve the period later (`NoIntensityAvailableError.mayImprove`).
- `mergeProvenance` marks a merged row provisional when either part is. Rows that differ only in the marker are not marked estimated because of it.
- The quality tier is not changed by the marker. The tests in `packages/grid-intensity/src/__tests__/provisional.test.ts` cover each case above.
