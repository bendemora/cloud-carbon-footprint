# Localised, time-resolved cloud carbon estimation

Design document for the next stage of this fork of Cloud Carbon Footprint (CCF).

| | |
|---|---|
| Status | Concepts approved by the project owner on 2026-11-05. Detailed design open for refinement during implementation. |
| Owner | Ben de Mora |
| Audience | Build sessions in Claude Code, and contributors once the project is published |
| Baseline | Fork trunk at upstream `f584c54` (CCF release line 2.x) plus PRs #1 to #3 |
| Related | `.adr/0022-grid_intensity_source_layer.md`, `CLAUDE.md` |

How to read this: sections 1 to 3 say what we are building and why. Sections 4 to 11 are the design. Section 12 is the phase plan with acceptance criteria, which is the order in which Claude Code sessions should work. Section 14 lists what still has to be verified against live services before the relevant phase starts. Facts that were checked against code or documentation are stated plainly; anything inferred or assumed is marked as such.

## 1. Summary

CCF today is a model, not a measurement: it converts billing usage to kilowatt-hours with published coefficients, multiplies by a provider PUE and a static annual grid factor per region, and adds embodied emissions. Its finest granularity is region, service, account and day. This design keeps the CCF estimators and replaces the one weakest link, the grid emissions factor, with a source layer that can deliver hourly, location-based carbon intensity from whichever sources a deployment is entitled to use, and records on every output row where each number came from.

On top of that layer it adds: hourly usage for the providers whose billing data supports it (AWS, GCP); availability-zone attribution of usage, labelled as regional intensity applied to zone-level usage; a published, versioned factor table of expected energy and carbon per unit of usage by service and region; calibration of the model against the providers' own monthly carbon reports; and an export in a FOCUS-aligned shape that loads into FinOps tooling such as Ternary through its Bring Your Own Data path.

The project is open-source first. Any data source with contractual terms (Electricity Maps commercial plans, purchased datasets, WattTime) is a plug-in that a deployment enables with its own credentials or files. The tool never ships, caches beyond permitted retention, or redistributes licensed data, and it makes the entitlement a user has, and the accuracy tier that entitlement buys, visible in one command.

## 2. Goals and non-goals

### Goals

1. Operational emissions per cloud provider, region, availability zone (where the billing data carries one), service and account, at hourly resolution where usage data allows and daily otherwise, using location-based grid intensity for the actual period.
2. An expected consumption rate per service per region: energy and carbon per unit of usage (per vCPU-hour, per GB-month, per GB transferred, and so on), published as a versioned dataset with provenance and uncertainty.
3. Calibration and validation of the model against provider-reported emissions (AWS Customer Carbon Footprint Tool, Google Cloud Carbon Footprint export, Azure Carbon Optimization), with the residuals reported rather than hidden.
4. A time-series export that FinOps platforms can ingest alongside cost, so carbon appears next to spend in existing dashboards. Ternary Bring Your Own Data is the first target.
5. Honest precision: every number carries the source, granularity, accounting basis, licence and model version it came from, and a quality tier that dashboards can show.
6. Open-source core with a clean boundary for commercial data sources whose contractual obligations are handled outside the tool.

### Non-goals

- Modelling market-based emissions. Market-based figures depend on the providers' contractual instruments (PPAs, RECs), which only the providers know. The tool carries provider-reported market-based figures where it has them, at the providers' monthly granularity, and labels them as reported, not modelled.
- Availability-zone grid intensity. Zones in a region draw from the same grid and no provider publishes per-zone PUE. The tool attributes usage to zones; it does not pretend to know zone-level intensity (section 8).
- Replacing the providers' own carbon reports. They are the calibration reference, not a competitor.
- A real-time dashboard. This is a batch pipeline with a cache, as CCF is today. Sub-hourly intensity data (5 or 15 minute) is accepted by the source layer but aggregated to the hour because no billing data is finer than that.
- Reworking the React client beyond what is needed to keep it working. The client stays at day granularity in this programme; the new value is delivered through the API, the CLI and the export.

## 3. Current state (verified against the code)

Paths are relative to the repo root. Identifiers are as they appear in the source.

### 3.1 Estimation pipeline

- Each provider package turns billing rows into `FootprintEstimate { timestamp, kilowattHours, co2e, usesAverageCPUConstant? }` (`packages/core/src/FootprintEstimate.ts`) using the estimators in `packages/core` (`ComputeEstimator`, `StorageEstimator`, `NetworkingEstimator`, `MemoryEstimator`, `UnknownEstimator`, `EmbodiedEmissionsEstimator`). Energy formulas are in those classes; for compute: `(minWatts + utilisation * (maxWatts - minWatts)) * vCpuHours * PUE * replicationFactor / 1000`, with utilisation defaulting to 50 % where the provider gives none.
- The carbon step is one multiplication keyed by region string only: `estimateCo2(kWh, region, emissionsFactors)` returns `kWh * (emissionsFactors[region] || emissionsFactors['Unknown'])` where `CloudConstantsEmissionsFactors = { [region: string]: number }` in tCO2e/kWh (`packages/core/src/CloudConstantsTypes.ts`). There is no time or zone dimension in that type.
- Static factors live in `packages/aws/src/domain/AwsFootprintEstimationConstants.ts` (`AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH`), `packages/gcp/src/domain/GcpFootprintEstimationConstants.ts` (`getGCPEmissionsFactors()`, grid or CFE-adjusted), `packages/azure/src/domain/AzureFootprintEstimationConstants.ts`, and the ALI and on-premise equivalents.
- Results are `EstimationResult { timestamp, serviceEstimates: ServiceData[], periodStartDate?, periodEndDate?, groupBy }` with `ServiceData { cloudProvider, kilowattHours, co2e, cost, usesAverageCPUConstant?, accountId, accountName, serviceName, region, tags? }` (`packages/common/src/EstimationResult.ts`). No zone, no provenance.
- `App.getCostAndEstimates` (`packages/app/src/App.ts`) runs each provider, concatenates and `reduceByTimestamp`s. It is wrapped by the `@cache()` decorator (`packages/app/src/Cache.ts`) with `LOCAL`, `GCS` and `MONGODB` backends. The cache persists final results only; the factor used for each row is not recorded anywhere.

### 3.2 Usage granularity

- `GroupBy` is `day | week | month | quarter | year` (`packages/common/src/Config.ts`). AWS truncates in Athena: `DATE(DATE_TRUNC('<grouping>', line_item_usage_start_date)) AS timestamp` (`packages/aws/src/lib/CostAndUsageReports.ts`, `getUsage`). GCP truncates in BigQuery: `DATE_TRUNC(DATE(usage_start_time), <grouping>)` (`packages/gcp/src/lib/BillingExportTable.ts`). Azure consumption rows are daily and are bucketed afterwards (`packages/azure/src/lib/ConsumptionManagement.ts`, `updateTimestampByGrouping`).
- Neither the AWS nor the GCP query selects an availability zone. AWS selects `product_region`; GCP selects `ifnull(location.region, location.location)`. `BillingDataRow` (`packages/core/src/BillingDataRow.ts`) has no zone field.

### 3.3 The existing Electricity Maps integration

`packages/common/src/EmissionsFactors.ts`:

- `getEmissionsFactors(region, dateTime, emissionsFactors, mappedRegionsToElectricityMapZones, logger)` calls `GET https://api.electricitymap.org/v3/carbon-intensity/past?zone=<zone>&datetime=<dateTime>` with the `auth-token` header when `ELECTRICITY_MAPS_TOKEN` is set and a zone mapping exists, and memoises per `(dateTime, zone)` in a module-level object that is never persisted.
- The `dateTime` passed in is the start of the truncated usage period (midnight UTC of the day, or the first day of the month). The `past` endpoint returns a single hourly value, so the current integration applies the midnight-hour intensity of the period's first day to the whole period. For a monthly grouping that is one hour out of 720. The documentation (`microsite/docs/ConfigurationOptions/EmissionsFactors.md`) describes this as "daily carbon intensity factors", which it is not.
- A zone the token cannot access returns a body without `carbonIntensity`; the code falls back to the static factor with a warning per row and repeats the failing call for every row of that zone and period (no negative caching).
- The region-to-zone maps are hand-maintained per provider (`AWS_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES` in `packages/aws/src/lib/AWSRegions.ts`, and the GCP and Azure equivalents). ALI and on-premise do not call `getEmissionsFactors` at all.
- The API is now v4 (section 5.2); v3 is what the code calls. The docs page also misspells the variable (`ELECTRICTY_MAPS_TOKEN`).

### 3.4 Other relevant facts

- `AWS_CLOUD_CONSTANTS.getPUE()` ignores its region argument although `CostAndUsageReports.ts` passes one. GCP has per-region trailing-twelve-month PUE; Azure uses a single 1.185.
- `App.getEmissionsFactors()` and the `GET /regions/emissions-factors` endpoint return the static maps only.
- `create-lookup-table` (`packages/cli/src/CreateLookupTable/`) already emits `serviceName, region, usageType, vCpus, machineType, kilowattHours, co2e` per unit of usage. It is the seed of the factor table in section 9.
- Methodology statement (`microsite/docs/HowItWorks/Methodology.md`): the application's focus is a location-based estimate; market-based reporting is welcomed as a contribution. This design follows that stance.

## 4. Design principles

1. **Capability negotiation, not tiers.** A deployment does not choose "free" or "paid". It configures sources; each source reports, per zone, what it can deliver and under what terms; the resolver picks the best available for each period and records the choice. Adding a commercial source changes the outcome, never the code path.
2. **Provenance on every row.** Source, granularity, accounting basis, factor type, estimation flag, licence, model version and calibration version travel with each service estimate into the cache, the API and the export. The quality tier (section 6.4) is derived from them.
3. **The tool holds no obligations.** It bundles no licensed data, embeds no credentials, enforces no vendor terms and redistributes nothing it is not told it may. It records what each source's terms are, applies the retention each source declares, writes a licence manifest with every export, and stops before including non-redistributable data unless the operator explicitly asserts they may.
4. **Keep the estimators.** The CCF energy model (coefficients, PUE, embodied) is retained and versioned. This programme changes the grid factor, the time resolution, the attribution dimensions and the outputs. Energy-model improvements are a separate track.
5. **Reproducibility.** Factor snapshots, model version and calibration version are stored so that a number can be re-derived later. Every fetched intensity point is persisted.
6. **FOCUS-aligned naming for everything that leaves the tool.** FOCUS v1.4 defines no carbon columns, so the export is a FOCUS-shaped extension (shared dimension names, our measures), not a claim of FOCUS conformance.
7. **Additive API changes only.** New fields are optional; existing consumers (the client, the CLI, the cache files) keep working.

## 5. Grid intensity sources

### 5.1 Catalogue

Facts below were checked against the sources' own documentation on 2026-11-05 unless marked "verify".

| Source | Coverage | Granularity | Lookback | Basis | Auth | Terms | Notes |
|---|---|---|---|---|---|---|---|
| Static annual factors (CCF constants) | All regions the provider packages define | Annual | Any | Location (GCP optionally CFE-adjusted) | None | Apache-2.0 (code) | Always available. Quality tier D. |
| Electricity Maps API v4 | 130+ zones; `dataCenterProvider` and `dataCenterRegion` parameters map cloud regions to zones on their side | 5 min, 15 min, hourly, daily, monthly (`temporalGranularity`) | `past-range`: 10 days per call hourly, 100 days daily; commercial plans include 3 months trailing history, longer by contract | Location; `emissionFactorType` lifecycle or direct; `flowTraced` default true (consumption-based) | `auth-token` header | Commercial: annual subscription per signal (carbon intensity EUR 6,000/year listed). Free tier: non-commercial; reported as one zone; endpoint scope not authoritatively documented (verify) | `GET /v4/zones` with a token lists the zones and endpoints that token may call. This is the capability probe. |
| Electricity Maps datasets (CSV) | Per zone | 5 min to hourly, daily | Multi-year (paid); 5 free downloads, non-commercial | Location | File | Per dataset terms | Loaded through the file source (5.4). |
| NESO Carbon Intensity API (Great Britain) | National plus 14 GB regions | 30 min, actual and forecast | Since 2017-09-26 | Location; production-based (NESO methodology) | None | CC BY 4.0 | `https://api.carbonintensity.org.uk`. Covers AWS eu-west-2, Azure UK South and UK West, GCP europe-west2. |
| ENTSO-E Transparency Platform | EU bidding zones | 15 min or 60 min generation per production type (document A75) | Multi-year | Derived: production mix converted with per-fuel factors (5.3); production-based | Security token (free registration) | Free; a published list of items that may be re-used without prior agreement. Confirm A75 is on it (verify) | Covers eu-central-1 (DE-LU), eu-west-1 (IE), eu-west-3 (FR), eu-north-1 (SE3), eu-south-1 (IT), and the GCP and Azure European regions. |
| EIA Open Data API v2 (United States) | Balancing authorities | Hourly generation by fuel type (`electricity/rto/fuel-type-data`, verify route and facets) | Multi-year | Derived as above | Free API key, passed in the URL | Public domain; attribution requested | 5,000 rows per request; throttle per their terms. Covers all US regions by balancing authority. |
| WattTime | Global (plan dependent) | 5 min marginal; also average | Plan dependent | Marginal (MOER) and average | Token | Commercial; free tier is index only | Later phase, optional. Marginal intensity answers "when to run" better than average but is a different quantity; keep it labelled. |
| BYO dataset (file source) | Whatever the file contains | As declared per row | As the file | As declared | None | As declared by the operator | Schema in 5.4. The commercial escape hatch. |

Sources not in this list are added by implementing one interface (section 6.1).

### 5.2 Electricity Maps specifics

- Base path moves to `/v4`. Use `GET /v4/carbon-intensity/past-range?zone=…&start=…&end=…&temporalGranularity=hourly` in 10-day windows, or `temporalGranularity=daily` in 100-day windows for daily usage. Do not use `past` for anything other than single-point lookups.
- Prefer `dataCenterProvider=<aws|gcp|azure>&dataCenterRegion=<region>` to their own mapping when the token permits it, and fall back to our registry (5.5). Their accepted provider values are not enumerated in the reference (verify in the Phase 1 spike).
- `emissionFactorType` and `flowTraced` are configuration with defaults `lifecycle` and `true`, recorded in provenance. Note that NESO and the mix-derived sources are production-based (no import tracing); mixing bases in one report is allowed but must be visible in the `IntensityBasis` field.
- Probe `GET /v4/zones` with the token at startup and cache the answer for `GRID_INTENSITY_CAPABILITY_TTL_HOURS` (default 24). A zone absent from the answer, or lacking the needed endpoint, is treated as unavailable without making data calls.
- Negative-cache plan and auth failures per zone for the TTL.
- Response field names for v4 are not in the public reference; capture them in recorded fixtures during the spike and assert on them in contract tests.

### 5.3 Deriving intensity from a generation mix (ENTSO-E, EIA)

Intensity for an interval = sum over fuels of (generation share × factor for that fuel). Factors are a versioned table in the grid-intensity package, defaulting to IPCC 2014 lifecycle medians (the same basis Electricity Maps documents for its default), overridable by configuration. Record `IntensityFactorType=lifecycle` and `IntensityBasis=production` on these points. Unknown or "other" fuel categories use a documented default and set `IntensityEstimated=true`. Imports are not traced in this programme; that is the main systematic difference from Electricity Maps' flow-traced numbers and it must be stated in the methodology page.

### 5.4 BYO dataset schema (file source)

CSV or Parquet files in `GRID_INTENSITY_DATASET_DIR`, one or more files, any partitioning. Columns:

| Column | Type | Required | Notes |
|---|---|---|---|
| `zone_id` | string | yes | The zone identifier in the namespace given by `zone_namespace` |
| `zone_namespace` | string | yes | `electricitymaps`, `entsoe`, `neso`, `eia`, or `custom` |
| `period_start_utc` | timestamp | yes | ISO 8601, UTC |
| `period_end_utc` | timestamp | yes | Exclusive end |
| `gco2e_per_kwh` | number | yes | |
| `basis` | string | yes | `location-consumption`, `location-production`, `marginal` |
| `factor_type` | string | yes | `lifecycle` or `direct` |
| `is_estimated` | boolean | no | Default false |
| `source` | string | yes | Free text naming the originating dataset |
| `licence_id` | string | yes | One of the licence ids in 6.3 |
| `attribution` | string | no | Attribution text required by the licence |

A purchased Electricity Maps dataset, or any vendor's export, is converted to this shape once (a small converter CLI ships for the Electricity Maps CSV layout) and then used by the resolver like any other source. This is the primary commercial path for users who have bought historical data rather than live API access.

### 5.5 Zone mapping registry

A single JSON registry in `packages/grid-intensity/src/registry/regions.json`, seeded from the three existing `*_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES` maps and extended per source:

```json
{
  "aws:eu-west-2": {
    "electricitymaps": "GB",
    "neso": { "regionId": 13, "name": "London" },
    "entsoe": null,
    "eia": null,
    "notes": "AWS London region; NESO region chosen by data-centre location (assumption, verify)"
  }
}
```

Each entry carries a `notes` field and the registry has a `version`. Tests assert every region in each provider's region enum has an entry (null is allowed and means "static factor only"). The registry is the one place a contributor edits to add coverage.

## 6. The grid-intensity package

New workspace package `@cloud-carbon-footprint/grid-intensity` at `packages/grid-intensity`. Depends on `common` only; `aws`, `gcp`, `azure`, `ali`, `on-premise` and `app` depend on it. The existing `packages/common/src/EmissionsFactors.ts` becomes a thin compatibility wrapper over the resolver and is removed in a later phase.

### 6.1 Interfaces

```ts
export type Granularity = 'hour' | 'day' | 'month' | 'year'
export type IntensityBasis = 'location-consumption' | 'location-production' | 'marginal'
export type EmissionFactorType = 'lifecycle' | 'direct'
export type LicenceId =
  | 'public-domain' | 'CC-BY-4.0' | 'open-attribution'
  | 'non-commercial' | 'commercial' | 'custom'

export interface LicenceDeclaration {
  id: LicenceId
  attribution?: string            // text to include wherever the data is shown
  redistributable: boolean        // may the derived dataset be shared with third parties
  retention: 'unlimited' | 'per-contract' | 'session'
  termsUrl?: string
}

export interface IntensityPoint {
  zoneId: string
  periodStart: Date               // UTC, inclusive
  periodEnd: Date                 // UTC, exclusive
  granularity: Granularity
  gCO2ePerKWh: number
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  sourceId: string
  retrievedAt: Date
}

export interface ZoneCapability {
  zoneId: string
  granularities: Granularity[]
  earliest?: Date                 // start of the lookback window the caller may fetch
  latest?: Date
  forecastHours?: number
  bases: IntensityBasis[]
  licence: LicenceDeclaration
}

export interface SourceStatus {
  reachable: boolean
  authenticated: boolean
  message?: string
}

export interface GridIntensitySource {
  readonly id: string                                  // 'electricitymaps', 'neso', ...
  readonly licence: LicenceDeclaration                 // default for the source; zones may narrow it
  probe(): Promise<SourceStatus>
  capabilities(zoneId: string): Promise<ZoneCapability | null>
  mapRegion(provider: CloudProvider, region: string): string | null
  fetch(zoneId: string, start: Date, end: Date, granularity: Granularity): Promise<IntensityPoint[]>
}

export interface IntensityStore {                        // persistence of fetched points
  get(sourceId: string, zoneId: string, start: Date, end: Date, granularity: Granularity): Promise<IntensityPoint[]>
  put(points: IntensityPoint[]): Promise<void>
  purge(sourceId: string, olderThan: Date): Promise<number>   // retention enforcement
}

export interface Provenance {
  sourceId: string
  zoneId: string
  granularity: Granularity
  basis: IntensityBasis
  factorType: EmissionFactorType
  isEstimated: boolean
  licenceId: LicenceId
  qualityTier: 'A' | 'B' | 'C' | 'D'
  modelVersion: string            // CCF energy model version (section 9)
  calibrationVersion?: string     // section 10
}

export interface ResolvedIntensity {
  gCO2ePerKWh: number             // time-weighted mean over [start, end)
  points: IntensityPoint[]
  provenance: Provenance
}

export interface IntensityResolver {
  resolve(provider: CloudProvider, region: string, start: Date, end: Date): Promise<ResolvedIntensity>
  capabilities(): Promise<CapabilityReport>              // for the doctor command and the API
}
```

The adapter for the estimators is one function that preserves today's call shape so provider packages change minimally:

```ts
// replaces getEmissionsFactors in packages/common
export async function resolveEmissionsFactors(
  provider: CloudProvider, region: string, periodStart: Date, periodEnd: Date,
): Promise<{ factors: CloudConstantsEmissionsFactors; provenance: Provenance }>
// factors = { [region]: gCO2ePerKWh / 1e6 }  (tCO2e/kWh, what estimateCo2 expects)
```

Implementation notes (Phase 1, recorded as the code landed):

- `resolveEmissionsFactors` takes a fifth argument, the caller's static table (`StaticFactorTable`: the factors, or a function returning them, plus the table's basis and factor type), and an optional resolver for tests. The static tables stay in the provider packages, so `grid-intensity` does not depend on them. When the static source is used, or no source can serve the region, the caller's table is returned unchanged, so tier-D estimates are identical to today's.
- `capabilities()` moved from `IntensityResolver` to a separate `CapabilityReporter` interface, implemented with the doctor command, because the list of provider regions to report on comes from the app layer.
- When every source is coarser than the usage period, the fallback round tries the finest first (a live monthly value beats the static annual one), keeping the configured order for ties.
- A fetched period with gaps is averaged over the covered part and marked `isEstimated` (tier C); fetched points outside 0 to 1,500 gCO2e/kWh are dropped with a warning. The bounds do not apply to sources with `persist: false` (the static tables): their values are not fetched or stored, and CCF's GCP multi-region factors are sums across data centres (`us` is 3,810).
- The sixth argument became an options object: `resolver` (tests), `legacyElectricityMapsZones` and `logger`. While `ELECTRICITY_MAPS_TOKEN` is set and no v4 source exists, the adapter first calls the existing v3 `getEmissionsFactors` with the provider's zone map, so deployments with a token keep today's values; the result is labelled `electricitymaps-v3`, granularity `hour`, `isEstimated` unless the usage period is that hour (tier C for daily rows), licence `custom`. The v4 source replaces this path. A failed v3 request (network error, a body that is not JSON, and now also HTTP 5xx and an HTTP 401 whose body says `Invalid auth-token`, which `getElectricityMapsData` used to return as a body without a value; a 401 whose body names the zone, `Request unauthorized for zoneKey=...`, is a valid token without access to that zone or endpoint and still falls back for the row, as verified against the live API on 2026-11-05) throws an `ElectricityMapsRequestError` and aborts the billing-data run, as a failed request did before; Azure's per-subscription catch lets it through instead of skipping the subscription. Falling back instead (as first merged) repeated the failing request for every billing row, and the estimates cache kept the fallback rows for good, because `getMissingDates` never re-estimates a cached day. Recommendations keep upstream's handling (AWS fails the request; GCP reports zero savings per recommendation, except that an idle-address recommendation, costed outside that catch, fails the request; Azure Advisor skips the subscription). Section 6.2's "never abort" applies to the resolver's own sources; the v4 source has to settle how a fallback interacts with the estimates cache before it replaces this path.
- Usage rows resolve over `usagePeriod(timestamp, grouping)`: from the row's timestamp to the start of the next day, week, month, quarter or year, exclusive (CCF's `getPeriodEndDate` is inclusive, one second short). Recommendations and lookup tables, which have no usage period, resolve over the last full UTC day (`lastFullUtcDay()`); with a token they used the current hour before.
- The default resolver lives for the process (one CLI run, or the API server's lifetime). The CLI and the API's shutdown handler call `shutdownDefaultResolver()`.
- `Provenance` and the literal types it uses (`Granularity`, `IntensityBasis`, `EmissionFactorType`, `LicenceId`, `QualityTier`) are defined in `packages/common`, because `ServiceData` carries provenance and `grid-intensity` depends on `common`; `grid-intensity` re-exports them. `Provenance` gained `gCO2ePerKWh`, the intensity applied to the row, which the export (11.1, `IntensityGCO2ePerKWh`) needs per row. A row's `kilowattHours` includes embodied emissions converted at that factor (upstream behaviour), so for every row with a `co2e` value, `co2e` = `kilowattHours` x `gCO2ePerKWh` / 1e6, and neither is an operational-only figure (an AWS row whose instance type CCF cannot size has a NaN `co2e`, upstream). Section 11.1's `EnergyKWh` ("operational energy") and the calibration in section 10 assume otherwise; that needs a decision before those phases.
- `ServiceData.provenance` and `FootprintEstimate.provenance` are optional. AWS, GCP and Azure billing rows carry it; ALI and on-premise rows do not yet (they do not call the resolver).
- When billing rows accumulate into one service estimate (same day, region, service, account and tags), their provenance is normally identical and kept. If it differs, the merged row takes the lower-tier row's fields except the licence, is marked `isEstimated` (tier C, or D if static), and its intensity is the energy-weighted mean of the two (`mergeProvenance` in `packages/core`). The licence is the more restrictive of the two, so a row with restricted data in it is never labelled open; two different licences at the same level become `open-attribution` or `custom`.
- A static factor of 0 is treated as missing, as `estimateCo2` does (`factors[region] || factors.Unknown`): the region maps to the table's `Unknown` zone and the provenance reports the Unknown factor, which is the factor applied. GCP's carbon-free-energy table has a 0 for `europe-north2` because Google reports the region as fully carbon-free, so the applied 188.94 gCO2e/kWh (the table's Unknown average) is an upstream overestimate. Correcting it changes estimates and is a model decision for section 9, not part of Phase 1.
- Unknown-usage rows now resolve grid intensity like every other row. Before, they always applied the static table, so with an Electricity Maps token the known and unknown rows of the same service, region and day used different factors.

### 6.2 Resolution policy

`GRID_INTENSITY_SOURCES` is an ordered list, for example `electricitymaps,neso,entsoe,eia,file,static`. For each (provider, region, period):

1. Map the region to a zone in each source, in order. Skip sources with no mapping.
2. Skip sources whose capability for that zone does not cover the period or cannot deliver a granularity at least as fine as the usage period, unless no finer source exists (then daily or monthly values are time-weighted over the usage period and the tier drops).
3. Skip sources whose licence id is not in `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` when the licence is `commercial`, `non-commercial` or `custom` (6.3).
4. Read from the store; fetch only the missing sub-ranges; persist what was fetched.
5. Compute the time-weighted mean over the usage period. When the usage period is an hour and the source is hourly, this is the hour's value.
6. Return with provenance. `static` always succeeds and is tier D.

Failures (network, auth, plan) are logged once per source and zone per run, negative-cached for the capability TTL, and never abort an estimation run.

### 6.3 Licence model (the commercial option)

Every source and every BYO dataset row declares a `LicenceDeclaration`. The tool's behaviour follows from it:

- **Enablement.** Sources whose licence is `commercial`, `non-commercial` or `custom` are inert until the operator lists them in `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS`, which is the operator's statement that they hold the necessary rights (for `non-commercial`, that the deployment is non-commercial). The tool does not verify this; it records it in the run log and the licence manifest.
- **Retention.** The store applies each source's `retention`: `unlimited` keeps points forever; `per-contract` keeps them for `GRID_INTENSITY_RETENTION_DAYS_<SOURCE>` and purges on each run; `session` never persists. Caching within the retention window is what lets a standard three-month-trailing subscription build a longer history over time; whether a given contract permits that is for the operator to check, which is why retention is configurable per source and defaults to `per-contract` for commercial sources.
- **Redistribution.** The export (section 11) writes a `DataLicence` column and a `licence-manifest.json` listing every source and attribution used. Rows whose source is not `redistributable` are excluded unless `--include-licensed-sources` is passed, which writes the operator's acknowledgement into the manifest.
- **Attribution.** Any output that shows intensity values (API, CLI, export manifest, client footer in a later phase) includes the attribution strings of the sources used. NESO's CC BY 4.0 and EIA's requested acknowledgement are satisfied this way.
- **Secrets.** Tokens are read through the existing `getEnvVar` (environment or `/run/secrets`). Nothing is written to the repo, the cache or the export.

What this buys: a user with nothing configured gets tier D everywhere and tier A or B in GB, the EU and the US from open sources. A user who buys Electricity Maps adds a token and an acknowledgement and gets tier A wherever their plan covers. A user who buys datasets drops files in a directory. The code is identical in all three cases.

### 6.4 Quality tiers

| Tier | Meaning |
|---|---|
| A | Intensity for the actual hour of usage, from a grid operator or an aggregator, usage at hourly granularity |
| B | Intensity averaged over the actual usage period (day or longer) from hourly or daily source data |
| C | Monthly or annual average from a live source, or a tier-A/B source with `isEstimated=true` for the period |
| D | Static annual constant from the CCF tables (today's behaviour) |

Tier is per service estimate row; a report can be summarised by the share of kWh in each tier.

### 6.5 The doctor command

`yarn ccf grid-intensity doctor` (new CLI command) prints, for every configured provider region: the zone in each source, the best available tier for the last 24 hours, the last 30 days and the last 12 months, the licence state (open, acknowledged, needs acknowledgement, unavailable) and any probe error. The same report is served by `GET /api/grid-intensity/capabilities`. This is the first thing a new user runs and the primary support tool.

### 6.6 Persistence

Store backends mirror CCF's cache modes: `LOCAL` (one JSON file per source, zone and calendar month under `GRID_INTENSITY_STORE_PATH`, default `.ccf/grid-intensity/`) and `MONGODB` (collection `grid-intensity-points`, reusing `MONGODB_URI`). No native dependencies: this keeps the multi-architecture install (PR #1) simple. A `GCS` backend follows the existing `GoogleCloudCacheManager` pattern if needed.

Implementation notes (Phase 1):

- LOCAL files are `<source>/<zone>/<YYYY-MM>.<granularity>.json` (annual points: `<YYYY>.year.json`), with source and zone ids percent-encoded, dots included, so no id can name a path outside the store. Writes go to a temporary file with a random name (process ids repeat across containers sharing a volume), and are renamed into place. Read-merge-write cycles on one file are serialised within a process, across every store on the directory, ignoring case; processes are not coordinated, so the later rename wins and the other process's points are fetched again when needed. Each file names its source and zone, and a file whose ids differ from the requested ones (ids that differ only in case share a path on a case-insensitive file system) is not read or written. A corrupt or unknown-version file fails the read with its path; the resolver then warns and carries on without the store. `purge` skips entries the store did not write, deletes temporary files last changed before the cut-off and over an hour ago, and reports unreadable files after purging the rest.
- MONGODB uses the `ccf` database (the one the estimates cache uses), one document per point, unique on source, zone, granularity and period start. It connects on first use. A failed connection is remembered for five minutes, so calls fail fast in that time, and then tried again, so a long-running API server recovers. `shutdownDefaultResolver()` closes it; the CLI and API call it next to the estimates cache's close once the wiring lands.
- `GRID_INTENSITY_STORE=MONGODB` without `MONGODB_URI`, or an unknown store mode, warns and keeps points in memory for the run.
- The static source is never stored (`persist = false` on the source): its values come from code, and stored copies would go stale when the tables change.

## 7. Hourly usage

Add `hour` to `GroupBy`. Changes, in dependency order:

1. `packages/common`: `GroupBy.hour`, `getPeriodEndDate` for hours, `getDatesWithinRequestTimeFrame` for hours.
2. `packages/aws`: `AWS_QUERY_GROUP_BY.hour = 'hour'`; the timestamp expression becomes `DATE_TRUNC('hour', line_item_usage_start_date)` (a timestamp, not `DATE(...)`); `convertAthenaRowToCostAndUsageReportsRow` parses it. Requires the Cost and Usage Report to be configured at hourly time granularity; the tool checks this once per run by comparing `count(distinct hour(line_item_usage_start_date))` to the day count in a one-day sample and refuses hourly grouping with a clear message if the report is daily.
3. `packages/gcp`: `TIMESTAMP_TRUNC(usage_start_time, HOUR)`; the standard billing export already carries `usage_start_time` and `usage_end_time`.
4. `packages/azure` and `packages/ali`: hourly is not available; they return daily rows and the resolver time-weights daily intensity, tier B. The API response marks the row granularity per provider.
5. `packages/app`: cache file naming (`estimates.cache.hour.json`), `getMissingDates` at hour resolution, request validation. Hourly local cache files will be large (see 11.4 for row counts); the docs recommend `CACHE_MODE=MONGODB` for hourly.
6. `packages/api`: `groupBy=hour` accepted on `/footprint`; the client is not changed to request it.
7. Athena cost: an hourly CUR query scans the same bytes as a daily one over the same date range (the aggregation is in the query), so the scan cost does not rise; the result set does. Measure on a real account in Phase 3 and record the numbers in the docs.

Deliverable enabled by this phase: a time-of-day report (CLI and API) that, per region, shows the intensity profile over the day and the share of the deployment's kWh falling into the best and worst quartiles of hours. This is the "when to run" question that daily data cannot ask.

## 8. Availability-zone attribution

- Add `availabilityZone?: string` to `BillingDataRow`, `ServiceData` and the AWS and GCP row types. AWS selects and groups by `line_item_availability_zone` (empty for non-zonal services), GCP by `location.zone`. Azure and ALI leave it null.
- Grouping by zone is opt-in (`INCLUDE_AVAILABILITY_ZONE=true`) because it multiplies row counts.
- Intensity is still resolved by region. The provenance `zoneId` is the grid zone, not the cloud zone, and the docs say in one sentence that zone-level emissions are zone-level usage multiplied by regional intensity, because no finer grid data exists.
- PUE: make `getPUE(region)` honour its argument for AWS (it does not today), and add `PUE_OVERRIDES` (JSON, keyed by `provider:region` or `provider:zone`) for operators who have obtained facility PUE from a provider under NDA. Overrides are marked `operator-supplied` in provenance and never committed.

## 9. Expected consumption rate: the factor table

A versioned, published dataset answering "what does one unit of this service in this region cost in energy and carbon".

- **Energy model version.** Introduce `MODEL_VERSION` in `packages/core` (semantic version, bumped whenever a coefficient table changes) and a `model-manifest.json` listing coefficient sources (CCF methodology, Teads EC2 dataset, Boavizta, provider PUE disclosures) with dates. Every output row carries it.
- **Generation.** Extend `create-lookup-table` into `export-factor-table`: for each provider, region, service, usage type and usage unit the estimators know, emit kWh per unit at utilisation 10 %, 50 % and 90 % (where utilisation applies), PUE used, embodied gCO2e per unit, and gCO2e per unit at: the static annual factor; the trailing-12-month mean, 10th and 90th percentile of hourly intensity from the store (where a tier A/B source exists). Columns carry the same provenance fields as everything else.
- **Format.** CSV and Parquet, with a JSON schema file and a `CHANGELOG`. Published under the repository's licence for the model and the static factors; rows derived from licensed sources follow 6.3.
- **Uncertainty.** The utilisation band and the intensity percentiles are the two dominant uncertainties and are published as columns rather than folded into one number. Claims beyond that (confidence intervals) are not made.

## 10. Calibration against provider-reported emissions

Provider reports are monthly and coarse but come from internal telemetry. They are used as a reference, in two modes.

| Provider | Source | Granularity | What it reports | Status |
|---|---|---|---|---|
| AWS | Customer Carbon Footprint Tool, also via Billing and Cost Management Data Exports | Monthly, by service (EC2, S3, CloudFront named); region breakdown not confirmed in the announcement (verify in the export schema) | Market-based since launch; location-based added June 2025 | Verify export table and columns |
| Google Cloud | Carbon Footprint export to BigQuery | Monthly; `project`, `service`, `location.region` | `carbon_footprint_kgCO2e.scope1`, `.scope2.location_based`, `.scope2.market_based`, `.scope3`, totals for both methods, `carbon_model_version` | Documented |
| Azure | Carbon Optimization export API (`Microsoft.Carbon/carbonEmissionReports`, api-version `2026-05-01-preview`) | Monthly; subscription, resource group, resource, location, resource type | Scopes 1 to 3 via `carbonScopeList`; accounting method not stated | Verify method; preview API |

- **Report mode (`CALIBRATION_MODE=report`, default once implemented).** For each provider, region and service with both a modelled and a reported figure for a month: compare modelled operational location-based (plus embodied, which approximates the providers' scope 3 share only loosely) with reported location-based scope 2 (plus scope 3 where separable). Emit a residual table: ratio, absolute difference, months covered. Publish it with the factor table so users see how far the model is from each provider's own number.
- **Apply mode (`CALIBRATION_MODE=apply`).** Derive per provider, region and service scaling factors from the trailing N months of residuals, store them in `calibration.json` with a `calibrationVersion`, and apply them to operational kWh. Rows carry the version. Apply mode is off by default because the providers' methods (boundaries, PUE, factor sources) differ from the model's and from each other; the residual is information first and correction second.
- Ingestion is batch (BigQuery query, Data Exports S3 read, Azure REST) through a small `packages/provider-reports` package with the same fixture-based contract tests as the intensity sources.

## 11. Export and Ternary integration

### 11.1 Dataset shape

One row per usage period, provider, account, service, region, zone (optional) and tag set. Column names follow FOCUS v1.4 where a FOCUS column exists; carbon measures are ours.

| Column | Type | FOCUS | Notes |
|---|---|---|---|
| `ChargePeriodStart` | timestamp | yes | UTC; required by Ternary BYOD |
| `ChargePeriodEnd` | timestamp | yes | |
| `ProviderName` | string | yes | `AWS`, `Google Cloud`, `Microsoft Azure`, `Alibaba Cloud`, `On-Premise` |
| `SubAccountId`, `SubAccountName` | string | yes | account or project |
| `ServiceName` | string | yes | |
| `RegionId` | string | yes | provider region code |
| `AvailabilityZone` | string | yes (recommended) | null unless section 8 enabled |
| `ConsumedQuantity`, `ConsumedUnit` | number, string | yes | optional, from the billing row |
| `EnergyKWh` | number | no | operational energy |
| `OperationalLocationKgCO2e` | number | no | modelled |
| `EmbodiedKgCO2e` | number | no | modelled |
| `OperationalMarketKgCO2e` | number | no | null unless provider-reported and the row is monthly (section 10) |
| `IntensityGCO2ePerKWh` | number | no | the resolved value used |
| `IntensitySource`, `IntensityZone`, `IntensityGranularity`, `IntensityBasis`, `IntensityFactorType`, `IntensityEstimated` | string/boolean | no | provenance |
| `QualityTier` | string | no | A to D |
| `ModelVersion`, `CalibrationVersion` | string | no | |
| `DataLicence`, `Attribution` | string | no | from the source licence |
| `Tags` | JSON string | yes (`Tags`) | the configured resource tags |

### 11.2 Exporter

`yarn ccf export-dataset --from 2026-01-01 --to 2026-02-01 --granularity hour --format parquet --destination s3://bucket/prefix/` (also `gs://`, `az://` and local paths). Partitioned by month, one file per partition, full rewrite of the requested range (matching Ternary's full-rebuild ingestion), `licence-manifest.json` alongside. Parquet is written with a pure-JavaScript writer; CSV is always available. The same code path backs a scheduled run (documented cron or GitHub Actions example, no new scheduler in the tool).

### 11.3 Ternary mapping

Ternary BYOD reads CSV, Parquet or BigQuery from S3, GCS, Azure Blob, Alibaba OSS or BigQuery; requires a date or timestamp mapped to `ChargePeriodStart`; allows custom dimensions and measures ("any time series numeric data"); appears as a "Custom Data" provider usable in the same reports as billing; refreshes every four hours; rebuilds fully each cycle; limits 10 M rows and 1 GB per file, 100 files per integration. The docs page for this feature in `microsite/docs/Integrations/` will carry the field mapping table (measures: the five numeric columns; everything else a dimension) and the join advice (same `SubAccountId`, `ServiceName`, `RegionId` values as the FOCUS billing data so cost and carbon group together).

Ternary's own carbon feature is Google Cloud only and monthly, so this export is additive for every provider and finer for Google Cloud.

### 11.4 Volume

Daily: accounts × services × regions × days. Hourly multiplies by 24. A deployment with 20 accounts, 40 services and 8 regions is about 190 k rows per month at daily and 4.6 M at hourly, under Ternary's per-file limit either way; with zones enabled, partition by month and provider.

## 12. Phase plan

Each phase is one or more PRs to `trunk` on the fork, each through the pre-commit hook and with green CI, with a changeset for every published package touched. Sizes are relative effort, not calendar estimates.

| Phase | Scope | Size | Depends on | Done when |
|---|---|---|---|---|
| 0 | This document, ADR 0022, `CLAUDE.md`; fix the Electricity Maps docs page (granularity claim, variable spelling) | S | none | Merged |
| 1 | `packages/grid-intensity` with interfaces, static source, Electricity Maps v4 source with capability probe, LOCAL and MONGODB stores, resolver, provenance on `ServiceData` (optional fields), `resolveEmissionsFactors` wired into AWS, GCP and Azure in place of `getEmissionsFactors`, `doctor` command, `GET /grid-intensity/capabilities`. Daily usage gets time-weighted daily intensity (fixes the midnight-sample defect) | L | 0 | Recorded-fixture contract tests pass; doctor shows correct tiers with and without a token; `yarn test` and e2e green; a daily run on a real account shows tier B where a token covers the zone and D elsewhere |
| 2 | Open sources: NESO, ENTSO-E, EIA with mix-to-intensity conversion and the per-fuel factor table; file source and the Electricity Maps CSV converter; licence acknowledgements, retention and manifest; registry with full coverage tests | L | 1 | A deployment with no paid source shows tier B for all GB, EU and US regions on a daily run; attribution appears in the doctor output and manifest |
| 3 | `GroupBy.hour` for AWS and GCP, hourly cache handling, API acceptance, CUR granularity check, time-of-day report | M | 1 | Hourly run on a real AWS account completes; rows are tier A where sources allow; time-of-day report produced; Athena scan cost recorded |
| 4 | Availability-zone attribution, region-aware AWS PUE, `PUE_OVERRIDES` | M | 3 | Zone rows present for EC2, EBS and RDS; docs state the attribution semantics; provenance marks overrides |
| 5 | Model version and manifest, `export-factor-table`, published schema and changelog | M | 2 | Factor table generated for all three providers with percentile columns; schema validated in CI |
| 6 | `packages/provider-reports`: AWS, GCP, Azure ingestion; `CALIBRATION_MODE=report`, then `apply` | L | 3, 5 | Residual table produced for at least one provider on real data; apply mode changes rows only when enabled and stamps `CalibrationVersion` |
| 7 | `export-dataset` with Parquet and CSV to S3, GCS, Azure Blob and local; licence manifest; Ternary integration docs; scheduled-run example | M | 3 (hourly), 6 optional | A Ternary BYOD integration on the EPEX tenant shows carbon next to cost by region and service |
| 8 | Publishing: README and microsite pages, methodology page updates (bases, tiers, calibration), CONTRIBUTING for sources, NOTICE and attribution file, upstream PR candidates identified (hook fixes, Electricity Maps v4, hourly grouping), first tagged release | M | 1 to 7 | Fresh clone follows README to a tier-B daily run with no paid data |

Suggested PR granularity inside a phase: interfaces and static source; one source per PR; resolver and wiring; CLI and API; docs. Keep each PR under about 800 changed lines where possible so the hook's test run stays useful.

## 13. Testing

- **Unit tests** per package with the existing jest setup and coverage thresholds; the new packages set 90 % statements and branches from the start.
- **Contract tests** for every external source use recorded fixtures under `src/__tests__/fixtures/` captured in the spike for that source (request shape, success body, auth failure, plan failure, empty range). No test calls the network; `global.fetch` is mocked the way `packages/common/src/__tests__/EmissionsFactors.test.ts` already does.
- **Resolver tests** cover fallback order, licence gating, retention purging, time-weighting across granularity mismatches and negative caching.
- **Data quality checks** run on fetched points before they are stored: 0 ≤ gCO2e/kWh ≤ 1500, contiguous periods, no overlap, and a gap report per zone.
- **Live smoke** (`GRID_INTENSITY_LIVE_TESTS=true`) runs the doctor against real endpoints; not in CI.
- **End-to-end** (TestCafe) remains as is; the client is unchanged in behaviour.
- **Schema tests** validate the factor table and export against their JSON schemas on every build.

## 14. Verification backlog

Items to confirm against live services before the phase that depends on them. Each becomes a short spike task with its findings recorded in the relevant docs page.

1. Electricity Maps v4: response field names for `past-range` and `zones`; accepted `dataCenterProvider` values; what the free tier returns from `/v4/zones`; terms on caching and retention of fetched data. (Phase 1)
2. ENTSO-E: that document type A75 (actual generation per production type) is on the free re-use list; token request lead time; per-zone resolution (PT15M vs PT60M). (Phase 2)
3. EIA: exact route (`electricity/rto/fuel-type-data` assumed), facets (`respondent`, `fueltype`), throttling thresholds. (Phase 2)
4. NESO: regional endpoint path and region ids; whether "actual" regional values exist or only forecasts for regions. (Phase 2)
5. AWS CUR hourly: whether the EPEX report is hourly; Athena result-set sizes and cost at hourly grouping. (Phase 3)
6. AWS CCFT Data Export: table name, columns, region availability, both accounting methods. (Phase 6)
7. Azure Carbon Optimization: accounting method behind the reported figures; stability of the preview API. (Phase 6)
8. Parquet writer choice for Node without native dependencies, and Ternary's acceptance of its output. (Phase 7)
9. GCP static grid and carbon-free-energy tables: accounting basis and factor type against Google's published method, to replace the `location-production` and `direct` defaults they are labelled with. (Phase 2)

## 15. Risks and mitigations

- **Mixed bases in one number.** Flow-traced (Electricity Maps) and production-based (NESO, ENTSO-E, EIA) intensities differ systematically. Mitigation: the basis is a first-class provenance field and the methodology page explains it; summaries can be filtered by basis.
- **Contract misunderstanding.** A user could cache or redistribute beyond their terms. Mitigation: retention defaults are conservative for commercial sources, the manifest records what was used, and the export refuses non-redistributable rows by default.
- **Hourly volume.** Local JSON caches will not scale to hourly across many accounts. Mitigation: MongoDB recommended for hourly; row estimates in the docs.
- **Upstream drift.** The fork will diverge from CCF. Mitigation: keep changes additive, PR the generic pieces upstream (section 12, phase 8), and sync trunk from upstream on a schedule.
- **Provider report churn.** The Azure API is preview; AWS Data Exports columns may change. Mitigation: contract tests with fixtures and a version field on each ingester.
- **Scope creep into market-based modelling.** Mitigation: non-goal, stated in the methodology page.

## 16. Open-source packaging

- Licence stays Apache-2.0 (upstream's). `NOTICE` gains the data-source attributions. A `DATA_SOURCES.md` lists each source, its terms and the acknowledgement the tool prints.
- The repository keeps upstream's package names during the programme. Renaming the published packages (or the repository) is a release-time decision for phase 8.
- Changesets drive versioning as upstream does; the first fork release is a major bump of every package whose public types gained provenance fields.
- CONTRIBUTING gains a section "Adding a grid intensity source" (implement the interface, add fixtures, add registry entries, declare the licence).

## 17. Glossary

- **Location-based**: emissions from the average intensity of the grid where energy is consumed. **Market-based**: emissions after contractual instruments (PPAs, RECs) are applied. **Production-based**: intensity of what a zone generates. **Consumption-based / flow-traced**: intensity of what a zone consumes, including imports.
- **Lifecycle vs direct factors**: whether upstream emissions of fuels and plant construction are included (lifecycle) or only combustion (direct).
- **Marginal intensity**: emissions of the next unit of demand (WattTime MOER); a different quantity from average intensity.
- **CFE**: carbon-free energy percentage; Google's hourly matching metric, reflected in CCF's optional CFE-adjusted factors.
- **PUE**: power usage effectiveness, facility energy divided by IT energy.
- **Embodied emissions**: manufacturing emissions of hardware, amortised over its life.
- **FOCUS**: FinOps Open Cost and Usage Specification; v1.4 defines no carbon columns.
- **BYOD**: Ternary's Bring Your Own Data integration.

## Appendix A: new configuration keys

| Key | Default | Purpose |
|---|---|---|
| `GRID_INTENSITY_SOURCES` | `static` | Ordered source list, e.g. `electricitymaps,neso,entsoe,eia,file,static` |
| `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` | empty | Comma-separated source ids the operator asserts they are licensed to use |
| `GRID_INTENSITY_STORE` | `LOCAL` | `LOCAL` or `MONGODB` |
| `GRID_INTENSITY_STORE_PATH` | `.ccf/grid-intensity` | LOCAL store directory |
| `GRID_INTENSITY_RETENTION_DAYS_<SOURCE>` | per source default | Retention for `per-contract` sources |
| `GRID_INTENSITY_CAPABILITY_TTL_HOURS` | `24` | Probe cache lifetime |
| `GRID_INTENSITY_DATASET_DIR` | unset | Directory for BYO dataset files |
| `GRID_INTENSITY_EMISSION_FACTOR_TYPE` | `lifecycle` | `lifecycle` or `direct` |
| `GRID_INTENSITY_FLOW_TRACED` | `true` | Electricity Maps `flowTraced` |
| `ELECTRICITY_MAPS_TOKEN` | existing | unchanged |
| `ENTSOE_SECURITY_TOKEN` | unset | |
| `EIA_API_KEY` | unset | |
| `INCLUDE_AVAILABILITY_ZONE` | `false` | Section 8 |
| `PUE_OVERRIDES` | unset | JSON map, section 8 |
| `CALIBRATION_MODE` | `off` | `off`, `report`, `apply` |

## Appendix B: references

- Electricity Maps API reference: https://app.electricitymaps.com/api/docs/reference
- Electricity Maps pricing and custom options: https://help.electricitymaps.com/en/articles/13169258-pricing-and-custom-options
- Electricity Maps datasets: https://help.electricitymaps.com/en/articles/13169264-datasets-and-csv-downloads
- NESO Carbon Intensity API: https://carbonintensity.org.uk/ (CC BY 4.0)
- ENTSO-E Transparency Platform knowledge base: https://transparency.entsoe.eu/content/static_content/Static%20content/knowledge%20base/knowledge%20base.html
- EIA Open Data API documentation: https://www.eia.gov/opendata/documentation.php and reuse policy: https://www.eia.gov/about/copyrights_reuse.php
- AWS Customer Carbon Footprint Tool, location-based emissions (June 2025): https://aws.amazon.com/about-aws/whats-new/2025/06/customer-carbon-footprint-tool-location-based-emissions/
- Google Cloud Carbon Footprint export schema: https://docs.cloud.google.com/carbon-footprint/docs/data-schema
- Azure Carbon Optimization export API: https://learn.microsoft.com/azure/carbon-optimization/api-export-data
- FOCUS specification v1.4: https://focus.finops.org/wp-content/uploads/2026/06/FOCUS_spec-v1_4.pdf
- Ternary Bring Your Own Data: https://docs.ternary.app/docs/bring-your-own-data-byod and Carbon Footprint: https://docs.ternary.app/docs/carbon-footprint
- CCF methodology: `microsite/docs/HowItWorks/Methodology.md`
