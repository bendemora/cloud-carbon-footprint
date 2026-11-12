# Localised, time-resolved cloud carbon estimation

Design document for the next stage of this fork of Cloud Carbon Footprint (CCF).

| | |
|---|---|
| Status | Concepts approved by the project owner on 2026-11-05. Detailed design open for refinement during implementation. Electricity Maps was taken out of the design on 2026-11-12 (ADR 0026). |
| Owner | Ben de Mora |
| Audience | Build sessions in Claude Code, and contributors once the project is published |
| Baseline | Fork trunk at upstream `f584c54` (CCF release line 2.x) plus PRs #1 to #3 |
| Related | `.adr/0022-grid_intensity_source_layer.md`, `.adr/0026-grid_intensity_from_primary_publishers.md`, `CLAUDE.md` |

How to read this: sections 1 to 3 say what we are building and why. Sections 4 to 11 are the design. Section 12 is the phase plan with acceptance criteria, which is the order in which Claude Code sessions should work. Section 14 lists what still has to be verified against live services before the relevant phase starts. Facts that were checked against code or documentation are stated plainly; anything inferred or assumed is marked as such.

## 1. Summary

CCF today is a model, not a measurement: it converts billing usage to kilowatt-hours with published coefficients, multiplies by a provider PUE and a static annual grid factor per region, and adds embodied emissions. Its finest granularity is region, service, account and day. This design keeps the CCF estimators and replaces the one weakest link, the grid emissions factor, with a source layer that can deliver hourly, location-based carbon intensity from whichever sources a deployment is entitled to use, and records on every output row where each number came from.

On top of that layer it adds: hourly usage for the providers whose billing data supports it (AWS, GCP); availability-zone attribution of usage, labelled as regional intensity applied to zone-level usage; a published, versioned factor table of expected energy and carbon per unit of usage by service and region; calibration of the model against the providers' own monthly carbon reports; and an export in a FOCUS-aligned shape that loads into FinOps tooling such as Ternary through its Bring Your Own Data path.

The project is open-source first. The live sources it builds in read the organisations that publish grid data themselves: system operators, market operators and public agencies, or the official body they publish through (ADR 0026). No tier needs a paid subscription. Data with contractual terms, a purchased dataset for example, is something a deployment loads itself, with its own files and an explicit acknowledgement. The tool never ships, caches beyond permitted retention, or redistributes licensed data, and it makes the sources a deployment can use, and the accuracy tier they give, visible in one command.

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

### 3.3 The Electricity Maps integration the fork inherited (removed)

Upstream CCF could replace the static factor with a value from Electricity Maps. ADR 0026 removed that integration on 2026-11-12. What it did is recorded here because its faults shaped the source layer.

- `getEmissionsFactors(region, dateTime, emissionsFactors, mappedRegionsToElectricityMapZones, logger)` in `packages/common/src/EmissionsFactors.ts` called `GET https://api.electricitymap.org/v3/carbon-intensity/past?zone=<zone>&datetime=<dateTime>` with the `auth-token` header when `ELECTRICITY_MAPS_TOKEN` was set and a zone mapping existed, and memoised per `(dateTime, zone)` in a module-level object that was never persisted.
- The `dateTime` passed in was the start of the truncated usage period (midnight UTC of the day, or the first day of the month). The `past` endpoint returns a single hourly value, so the integration applied the midnight-hour intensity of the period's first day to the whole period. For a monthly grouping that is one hour out of 720.
- A zone the token could not access returned a body without `carbonIntensity`; the code fell back to the static factor with a warning per row and repeated the failing call for every row of that zone and period (no negative caching).
- The region-to-zone maps were hand-maintained per provider (`AWS_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES` in `packages/aws/src/lib/AWSRegions.ts`, and the GCP and Azure equivalents). They are kept as the grid zone registry (section 5.5). ALI and on-premise never called `getEmissionsFactors`.

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
| NESO Carbon Intensity API (Great Britain) | National, actual and forecast. Regional, forecast only: 14 DNO regions and the England, Scotland, Wales and GB aggregates | 30 min. Actual for the national series only. Forecast about 2 days ahead | National from 2017-09-11T23:00Z, regional from 2018-05-10T23:30Z | Location; consumption-based (generation plus interconnector imports over demand, corrected for losses); direct CO2 factors, gCO2/kWh not gCO2e/kWh | None | CC BY 4.0; API terms of use with an unpublished rate limit; no prescribed attribution wording | `https://api.carbonintensity.org.uk`. Covers AWS eu-west-2, Azure UK South and UK West, GCP europe-west2. Range requests must be under 31 days (documentation says 14). GB cloud regions resolve to the national series. This row was checked against the live API and NESO's documentation on 2026-11-10; see `docs/design/spikes/2026-11-neso.md`. The regional start date was checked for one region (13). |
| ENTSO-E Transparency Platform | EU bidding zones | 15 min or 60 min generation per production type (document A75) | Multi-year | Derived: production mix converted with per-fuel factors (5.3); production-based | Security token (free registration) | Free; a published list of items that may be re-used without prior agreement. Confirm A75 is on it (verify) | Covers eu-central-1 (DE-LU), eu-west-1 (IE), eu-west-3 (FR), eu-north-1 (SE3), eu-south-1 (IT), and the GCP and Azure European regions. |
| EIA Open Data API v2 (United States) | Balancing authorities | Hourly generation by fuel type (`electricity/rto/fuel-type-data`, verify route and facets) | Multi-year | Derived as above | Free API key, passed in the URL | Public domain; attribution requested | 5,000 rows per request; throttle per their terms. Covers all US regions by balancing authority. |
| BYO dataset (file source) | Whatever the file contains | As declared per row | As the file | As declared | None | As declared by the operator | Schema in 5.4. The route for data a deployment has obtained itself. |

Every live source built in reads a primary publisher: the system operator, market operator or public agency that publishes the data, or the official body it publishes through, as ENTSO-E is for the European operators and EIA for the United States balancing authorities (ADR 0026). The static factors are not live data; they are constants that upstream CCF compiled, and section 14, item 9, records where the Google Cloud ones come from. Services that republish or model the publishers' data are not built in. Electricity Maps and WattTime, which earlier versions of this table listed, are the two that were considered. A deployment that holds such data can load it through the file source (5.4). Sources not in this list are added by implementing one interface (section 6.1).

#### Candidates from the survey of 2026-11-06

A desk survey looked for a free primary publisher of hourly data for each of the 48 grid zones in the registry (`docs/design/research/2026-11-primary-publishers.md`). It found one whose licence, as found, allows commercial use for 19 zones: Great Britain and the eight United States zones through the sources above, and the ten zones below. These rows are leads, not checked facts. Most publishers' own pages could not be opened from the session that ran the survey, so each row rests on search results and third-party code, and each needs a short spike (licence and endpoint read on the publisher's pages, fixtures recorded) before a source is built, as NESO had.

| Publisher | Grid zones | What it publishes | Licence as found | Note |
|---|---|---|---|---|
| RTE eCO2mix, through the ODRE portal | FR | Intensity and mix, 15 to 30 min, from 2012 | Licence Ouverte 2.0 | Intensity is published, so no factor table is needed. Production basis, direct factors |
| SMARD (Bundesnetzagentur) | DE | Mix, 15 min | CC BY 4.0 | Energy-Charts (Fraunhofer ISE) publishes the same zone, also CC BY 4.0 |
| Elia Open Data | BE | Intensity on a production and a consumption basis | CC BY 4.0 | Resolution and start date not confirmed |
| Fingrid Open Data | FI | Intensity on both bases, 3 min and 15 min | CC BY 4.0 | |
| Elhub | NO-NO1, NO-NO2 | Mix by production group, hourly, from 2021 | CC BY 4.0 | |
| eSett Open Data | SE-SE3, also FI and NO | Mix, hourly, from May 2017 | CC0, from an old copy of the homepage | Thermal generation is not split by fuel |
| ONS open data portal | BR-CS | Generation by plant, hourly | CC BY 4.0, by the AWS Open Data Registry entry | That the subsystem matches BR-CS is inferred |
| Electricity Authority EMI | NZ | Generation by plant, half-hourly | CC BY 4.0 by default | Needs a table of each plant's fuel |
| Taipower, through data.gov.tw | TW | Generation by unit, 10 min | Taiwan Open Government Data License 1.0 | Needs a table of each unit's fuel; depth of the archive unclear |

For the EU zones among these, the operator is the primary publisher in the sense of ADR 0026 and ENTSO-E, which republishes the operators' reports, is the fallback. ENTSO-E remains the only route found for IE, NL, ES, IT-NO and PL, which is why its licence question (section 14, item 2) matters. Sixteen zones have free hourly data whose licence is unresolved or refuses commercial use, India's three zones have daily data only, and for ten zones nothing was found; the survey lists them.

### 5.2 Electricity Maps (removed)

This section described the Electricity Maps v4 source. ADR 0026 cancelled that source and removed the v3 lookup the fork inherited (section 3.3), so there is nothing to build here. The heading is kept so that section numbers used elsewhere stay valid.

Two points made here apply to every source and still hold:

- Sources differ in accounting basis and factor type, and the difference is never hidden. Mixing bases in one report is allowed but must be visible in the `IntensityBasis` field. Section 5.3 gives the basis of intensity derived from a generation mix, and `docs/design/spikes/2026-11-neso.md` gives NESO's.
- A failed capability probe or a refused request is remembered per zone for `GRID_INTENSITY_CAPABILITY_TTL_HOURS` (default 24), so a source that cannot serve a zone is not called again for every row.

### 5.3 Deriving intensity from a generation mix (ENTSO-E, EIA)

Intensity for an interval = sum over fuels of (generation share × factor for that fuel). Factors are a versioned table in the grid-intensity package, defaulting to IPCC 2014 lifecycle medians, overridable by configuration. Record `IntensityFactorType=lifecycle` and `IntensityBasis=production` on these points. Unknown or "other" fuel categories use a documented default and set `IntensityEstimated=true`. Imports are not traced in this programme, so a zone that imports much of its electricity is described by what it generates and not by what it consumes. That limit must be stated in the methodology page.

### 5.4 BYO dataset schema (file source)

CSV or Parquet files in `GRID_INTENSITY_DATASET_DIR`, one or more files, any partitioning. Columns:

| Column | Type | Required | Notes |
|---|---|---|---|
| `zone_id` | string | yes | The zone identifier in the namespace given by `zone_namespace` |
| `zone_namespace` | string | yes | `grid-zone` (the identifiers of the grid zone registry, 5.5), `entsoe`, `neso`, `eia`, or `custom` |
| `period_start_utc` | timestamp | yes | ISO 8601, UTC |
| `period_end_utc` | timestamp | yes | Exclusive end |
| `gco2e_per_kwh` | number | yes | |
| `basis` | string | yes | `location-consumption`, `location-production`, `marginal` |
| `factor_type` | string | yes | `lifecycle` or `direct` |
| `is_estimated` | boolean | no | Default false |
| `source` | string | yes | Free text naming the originating dataset |
| `licence_id` | string | yes | One of the licence ids in 6.3 |
| `attribution` | string | no | Attribution text required by the licence |

A dataset a deployment has obtained elsewhere, bought or not, is converted to this shape once by its owner and then used by the resolver like any other source. The tool ships no converter for any vendor's layout (ADR 0026).

### 5.5 Grid zone registry

`packages/grid-intensity/src/registry/gridZones.ts` maps the AWS, GCP and Azure regions to the electricity grid each is on, or to null where the grid is not known. It was seeded from the three region-to-zone maps the provider packages held for the Electricity Maps lookup (section 3.3), which ADR 0026 kept when it removed the lookup.

A grid zone identifier is a country code, followed by a grid area where the zone list divides the country: a bidding zone (`SE-SE3`, `NO-NO1`, `IT-NO`), a balancing authority (`US-MIDA-PJM`, `US-CAL-CISO`), a market region (`AU-NSW`) or a regional system (`IN-WE`, `JP-TK`, `BR-CS`). The identifiers are the ones the inherited maps used, unchanged. Their naming follows the zone list of the open `electricitymaps-contrib` repository, which upstream CCF adopted. The registry takes nothing else from Electricity Maps.

A cloud region reaches a source's data in two steps:

1. Region to grid zone: the registry. `gridZoneOf(provider, region)` answers it, and the capability report shows it for every region (section 6.5).
2. Grid zone to the source's own zone: each source holds that table for the zones it serves, for example `GB` to the NESO national series, or a grid zone to an ENTSO-E area code or an EIA balancing authority code. A source's `mapRegion` composes the two steps.

So adding a cloud region is one registry entry, and adding a source is one table keyed by grid zone. Where a source needs a choice finer than the grid zone (a NESO regional series for a data centre's location, for example), it holds that as an exception keyed by provider and region; `docs/design/spikes/2026-11-neso.md`, section 8.3, records the candidates for NESO.

A test in each provider package asserts that the registry names only regions of that provider's region table. A region that is absent or null has no grid zone and is served by the static factors only. The registry carries a version number, raised whenever a mapping changes. The inherited mappings have not been checked against the providers' own location data; that is part of Phase 2 ("registry with full coverage tests"). One pair looks inconsistent as it stands: AWS `us-east-2` (US East (Ohio)) is on `US-MIDW-MISO`, while GCP `us-east5` (Columbus, Ohio, by Google's region list) is on `US-MIDA-PJM`. Unless the two providers' Ohio sites are on different grids, one entry is wrong (inferred, not checked). It matters from the first source that covers the United States. A comparison made on 2026-11-12 for the review of this change gives the check somewhere to start: the data centre list of the open `electricitymaps-contrib` repository (`config/data_centers/data_centers.json` at commit `2faa955a`) covers 110 of the registry's entries, agrees with 104 and differs on six: AWS `us-east-2` (it has `US-MIDA-PJM`) and `ca-central-1` (`CA-QC`), GCP `us-central1` (`US-CENT-SWPP`), and Azure `NorthCentralUs` (`US-MIDA-PJM`), `westus2` (`US-NW-BPAT`) and `westus3` (`US-SW-AZPS`). Which side is right was not checked, and nothing was copied from that list.

## 6. The grid-intensity package

New workspace package `@cloud-carbon-footprint/grid-intensity` at `packages/grid-intensity`. Depends on `common` only; `aws`, `gcp`, `azure`, `ali`, `on-premise` and `app` depend on it. `packages/common/src/EmissionsFactors.ts`, the lookup the adapter replaced, was removed with ADR 0026.

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
  readonly id: string                                  // 'neso', 'entsoe', 'static', ...
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
- The sixth argument is an options object with one field, `resolver`, which tests use in place of the default resolver. Until ADR 0026 it also carried the provider's Electricity Maps zone map and a logger, because the adapter ran the v3 lookup ahead of the sources while `ELECTRICITY_MAPS_TOKEN` was set: the rows that lookup served were labelled `electricitymaps-v3` (tier C for daily usage), and a failed request stopped the billing-data run with an `ElectricityMapsRequestError`, so that the estimates cache kept no fallback rows. All of that is removed. A source that fails now always falls back (section 6.2), and ADR 0025 covers what the cache keeps. Recommendations keep upstream's handling of errors (AWS fails the request; GCP reports zero savings per recommendation, except that an idle-address recommendation, costed outside that catch, fails the request; Azure Advisor skips the subscription), and Azure billing data again leaves out a subscription whose estimate fails, as upstream does.
- Usage rows resolve over `usagePeriod(timestamp, grouping)`: from the row's timestamp to the start of the next day, week, month, quarter or year, exclusive (CCF's `getPeriodEndDate` is inclusive, one second short). Recommendations and lookup tables, which have no usage period, resolve over the last full UTC day (`lastFullUtcDay()`); upstream's Electricity Maps lookup sampled the current hour for them.
- The default resolver lives for the process (one CLI run, or the API server's lifetime). The CLI and the API's shutdown handler call `shutdownDefaultResolver()`.
- `Provenance` and the literal types it uses (`Granularity`, `IntensityBasis`, `EmissionFactorType`, `LicenceId`, `QualityTier`) are defined in `packages/common`, because `ServiceData` carries provenance and `grid-intensity` depends on `common`; `grid-intensity` re-exports them. `Provenance` gained `gCO2ePerKWh`, the intensity applied to the row, which the export (11.1, `IntensityGCO2ePerKWh`) needs per row. A row's `kilowattHours` includes embodied emissions converted at that factor (upstream behaviour), so for every row with a `co2e` value and a non-zero `gCO2ePerKWh`, `co2e` = `kilowattHours` x `gCO2ePerKWh` / 1e6, and neither is an operational-only figure (an AWS row whose instance type CCF cannot size has a NaN `co2e`, upstream). Section 11.1's `EnergyKWh` ("operational energy") and the calibration in section 10 assume otherwise, which needed a decision before those phases. The same decision covers intensities at or near 0: at 0 the embodied kWh are 0 (there is no factor to convert at) while `co2e` still includes the embodied emissions, and just above 0 the converted embodied kWh grow without bound (0.002 t at 0.5 g/kWh is 4,000 kWh). ADR 0024 is that decision, and it is built: rows from billing data carry `operationalKilowattHours` and `embodiedCo2e`, and `co2e` = `operationalKilowattHours` x `gCO2ePerKWh` / 1e6 + `embodiedCo2e` holds at any intensity, 0 included. The export, the factor table, the time-of-day report and calibration will read those two fields. `kilowattHours` keeps upstream's definition until the model version decides otherwise.
- `ServiceData.provenance` and `FootprintEstimate.provenance` are optional. AWS, GCP and Azure billing rows carry it; ALI and on-premise rows do not yet (they do not call the resolver).
- When billing rows accumulate into one service estimate (same day, region, service, account and tags), their provenance is normally identical and kept. If it differs, the merged row takes the lower-tier row's fields except the licence, is marked `isEstimated` (tier C, or D if static), and its intensity is the mean of the two (`mergeProvenance` in `packages/core`), weighted by each row's electricity (`operationalKilowattHours`) when both rows carry it, so the identity of ADR 0024 holds on the merged row, and by the legacy `kilowattHours` otherwise. The licence is the more restrictive of the two, so a row with restricted data in it is never labelled open; two different licences at the same level become `open-attribution` or `custom`.
- A static factor of 0 is treated as missing, as `estimateCo2` does (`factors[region] || factors.Unknown`): the region maps to the table's `Unknown` zone and the provenance reports the Unknown factor, which is the factor applied. GCP's carbon-free-energy table has a 0 for `europe-north2` because Google reports the region as fully carbon-free, so the applied 188.94 gCO2e/kWh (the table's Unknown average) is an upstream overestimate. Correcting it changes estimates and is a model decision for section 9, not part of Phase 1.
- Unknown-usage rows now resolve grid intensity like every other row. Before, they always applied the static table, so with a value from the Electricity Maps lookup (since removed, ADR 0026) the known and unknown rows of the same service, region and day used different factors.

### 6.2 Resolution policy

`GRID_INTENSITY_SOURCES` is an ordered list, for example `neso,entsoe,eia,file,static`. For each (provider, region, period):

1. Map the region to a zone in each source, in order. Skip sources with no mapping.
2. Skip sources whose capability for that zone does not cover the period or cannot deliver a granularity at least as fine as the usage period, unless no finer source exists (then daily or monthly values are time-weighted over the usage period and the tier drops).
3. Skip sources whose licence id is not in `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` when the licence is `commercial`, `non-commercial` or `custom` (6.3).
4. Read from the store; fetch only the missing sub-ranges; persist what was fetched.
5. Compute the time-weighted mean over the usage period. When the usage period is an hour and the source is hourly, this is the hour's value.
6. Return with provenance. `static` always succeeds and is tier D.

Failures (network, authentication, a refused request) are logged once per source and zone per run, negative-cached for the capability TTL, and never abort an estimation run.

Implementation notes (Phase 1):

- Step 2 compares a source's finest granularity with the coarsest granularity whose shortest period fits in the usage period: a week takes daily data, a quarter monthly data, so monthly data is coarser than a week and annual data coarser than a quarter.
- The capability window limits what is fetched, not what is used (6.3: stored history is what lets a source with a short lookback build a longer record). Step 4 reads the store first; only missing periods that lie wholly inside `[earliest, latest]` are fetched, so a source reports both on its own period boundaries. A day or hour that runs past `latest` (today) is served from the source's finest granularity up to `latest`, and its partial coverage marks it estimated; longer periods keep their usual granularity and lose only the incomplete last period.
- A source that covers only part of the period is a fallback, not the answer: later sources are tried, and the first that covers the whole period at a tier no worse than the best partial result wins (so a full later live source beats it, and the static source does not). With no full result, the partial one with the best tier, then coverage, is used.
- A failed fetch or capability probe stops that zone's fetches for the TTL, but stored points are still used. After a failed probe the last known capability is kept; in a fresh process with none, the store is read at each granularity, finest first.
- Fetched points that are not whole UTC periods of the requested granularity, source and zone are dropped with a warning, so points never overlap and coverage cannot read 1 over a gap.
- Warnings are logged at most once per source, zone and kind per TTL rather than per run, because the default resolver lives for the API server's process. Store read and write failures are reported per source and zone, and again after the store has worked in between.
- Points from `session`-retention sources are kept in an in-memory store owned by the resolver and released by the first resolve call after the TTL, so a run fetches each period once; they are never written to the configured store.
- A resolved intensity of 0 reaches `estimateCo2` as both the region and the `Unknown` factor, because `estimateCo2` treats 0 as missing; `estimateKwh` returns 0 kWh rather than Infinity when no non-zero factor exists.

### 6.3 Licence model (the commercial option)

Every source and every BYO dataset row declares a `LicenceDeclaration`. The tool's behaviour follows from it:

- **Enablement.** Sources whose licence is `commercial`, `non-commercial` or `custom` are inert until the operator lists them in `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS`, which is the operator's statement that they hold the necessary rights (for `non-commercial`, that the deployment is non-commercial). The tool does not verify this; it records it in the run log and the licence manifest.
- **Retention.** The store applies each source's `retention`: `unlimited` keeps points forever; `per-contract` keeps them for `GRID_INTENSITY_RETENTION_DAYS_<SOURCE>` and purges on each run; `session` never persists. Caching within the retention window is what lets a source with a short lookback build a longer history over time; whether the terms of a licensed source permit that is for the operator to check, which is why retention is configurable per source and defaults to `per-contract` for commercial sources.
- **Redistribution.** The export (section 11) writes a `DataLicence` column and a `licence-manifest.json` listing every source and attribution used. Rows whose source is not `redistributable` are excluded unless `--include-licensed-sources` is passed, which writes the operator's acknowledgement into the manifest.
- **Attribution.** Any output that shows intensity values (API, CLI, export manifest, client footer in a later phase) includes the attribution strings of the sources used. NESO's CC BY 4.0 and EIA's requested acknowledgement are satisfied this way.
- **Secrets.** Tokens are read through the existing `getEnvVar` (environment or `/run/secrets`). Nothing is written to the repo, the cache or the export.

What this buys: with the default configuration every row is tier D. Listing the open sources in `GRID_INTENSITY_SOURCES`, with the free ENTSO-E token and EIA key of Appendix A, gives tier A or B in GB, the EU and the US. A user who holds a licensed dataset drops files in a directory and acknowledges the licence. The code path is the same in both cases, and neither needs a paid subscription to an aggregator (ADR 0026).

### 6.4 Quality tiers

| Tier | Meaning |
|---|---|
| A | Intensity for the actual hour of usage, from a primary publisher or a loaded dataset, usage at hourly granularity |
| B | Intensity averaged over the actual usage period (day or longer) from hourly or daily source data |
| C | Monthly or annual average from a live source, or a tier-A/B source with `isEstimated=true` for the period |
| D | Static annual constant from the CCF tables (today's behaviour) |

Tier is per service estimate row; a report can be summarised by the share of operational kWh in each tier.

### 6.5 The doctor command

`yarn ccf grid-intensity doctor` (new CLI command) prints, for every configured provider region: the zone in each source, the best available tier for the last 24 hours, the last 30 days and the last 12 months, the licence state (open, acknowledged, needs acknowledgement, unavailable) and any probe error. The same report is served by `GET /api/grid-intensity/capabilities`. This is the first thing a new user runs and the primary support tool.

Implementation notes (Phase 1b, recorded as the code landed in PRs #23, #25 and #26):

- The command is the `grid-intensity-doctor` script of `packages/cli`, run as `yarn workspace @cloud-carbon-footprint/cli grid-intensity-doctor`, because the CLI's commands are `package.json` scripts. There is no `yarn ccf` entry point and no alias in the root `package.json`.
- The report covers every region in the region tables of AWS, GCP (regions, dual-regions and multi-regions) and Azure, less any provider whose `<PROVIDER>_INCLUDE_ESTIMATES` is `false`. `packages/app` builds the list (`App.getGridIntensityCapabilities()`) and gives it to `createCapabilityReporter` with each provider's static table, so `grid-intensity` still depends on no provider package. Alibaba Cloud and on-premise are not reported, because their estimates do not use the source layer.
- Tiers are for a day of usage, the finest `GroupBy`, so hourly data shows as tier B and tier A cannot appear before Phase 3. `REPORT_USAGE_GRANULARITY` holds this; Phase 3 needs it per provider, since Azure stays daily.
- The best tier of a window is the best over the UTC days that overlap it. `SourceCapabilitySummary` gained `coverage`, the share of those days the source can serve in whole or in part, because the tier alone cannot tell a three-month lookback from a three-year one. The doctor prints it as a percentage after the tier when it is below 100. The summary also gained `attribution`, held per source and zone because a zone may narrow the source's licence.
- Tiers and shares are derived from each zone's capability (granularities, `earliest`, `latest`) by the rules the resolver applies to a day of usage (`granularityFor`, `isWithinWindow`). The report calls no data endpoint and does not read the store, so points stored from before a source's lookback window, which estimates use, are not counted.
- Licence state is `unavailable` when the source has no zone for the region, answers that it has no capability for the zone, or lists no granularities. A source that needs acknowledgement still shows the tier it would deliver. A zone whose capability probe failed before it ever answered takes the state of the source's own licence, shows no tier, and carries the error.
- The error is the source's `probe()` answer when it is not reachable or not authenticated, joined with the reason the resolver has stopped the zone's fetches. The resolver now remembers that reason, and keeps each source's probe answer for the capability TTL so that the endpoint does not call a source on every request (`GridIntensityResolver.sourceViews`). The API server reports on the resolver its estimates use, so it shows the failures they have met; the command starts from nothing each time.
- Each region carries `gridZoneId`: its zone in the grid zone registry (section 5.5), or null when it has none. The doctor prints it in a `Grid zone` column. Until ADR 0026 the report instead carried the state of the Electricity Maps v3 lookup, and each region's Electricity Maps zone, while `ELECTRICITY_MAPS_TOKEN` was set.
- Verified by running the command on 2026-11-10: with the default configuration it lists 171 regions (39 AWS, 51 GCP, 81 Azure), all tier D from the static source. Run again on 2026-11-12 after ADR 0026: the same 171 regions, 134 of them with a grid zone and 37 without. Lookback, late data, the other licence states and errors are tested with a fake source and have not been seen with a live one.

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

Deliverable enabled by this phase: a time-of-day report (CLI and API) that, per region, shows the intensity profile over the day and the share of the deployment's operational kWh falling into the best and worst quartiles of hours. This is the "when to run" question that daily data cannot ask.

## 8. Availability-zone attribution

- Add `availabilityZone?: string` to `BillingDataRow`, `ServiceData` and the AWS and GCP row types. AWS selects and groups by `line_item_availability_zone` (empty for non-zonal services), GCP by `location.zone`. Azure and ALI leave it null.
- Grouping by zone is opt-in (`INCLUDE_AVAILABILITY_ZONE=true`) because it multiplies row counts.
- Intensity is still resolved by region. The provenance `zoneId` is the source's zone for the region, an electricity zone and not the cloud availability zone, and the docs say in one sentence that zone-level emissions are zone-level usage multiplied by regional intensity, because no finer grid data exists.
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
| 1 | `packages/grid-intensity` with interfaces, static source, LOCAL and MONGODB stores, resolver, provenance on `ServiceData` (optional fields), `resolveEmissionsFactors` wired into AWS, GCP and Azure in place of `getEmissionsFactors`, `doctor` command, `GET /grid-intensity/capabilities`. The Electricity Maps v4 source that was in this phase is cancelled, and the v3 lookup with its midnight-sample defect is removed (ADR 0026) | L | 0 | Doctor shows tier D for every region with the default configuration; `yarn test` and e2e green. The daily run on a real account moved to Phase 2 with ADR 0026 |
| 2 | Open sources: NESO, ENTSO-E, EIA with mix-to-intensity conversion and the per-fuel factor table; file source; licence acknowledgements, retention and manifest; registry with full coverage tests | L | 1 | A deployment with no paid source shows tier B for all GB, EU and US regions on a daily run; a daily run on a real account shows tier B where an open source covers the region and D elsewhere; attribution appears in the doctor output and manifest |
| 3 | `GroupBy.hour` for AWS and GCP, hourly cache handling, API acceptance, CUR granularity check, time-of-day report | M | 1 | Hourly run on a real AWS account completes; rows are tier A where sources allow; time-of-day report produced; Athena scan cost recorded |
| 4 | Availability-zone attribution, region-aware AWS PUE, `PUE_OVERRIDES` | M | 3 | Zone rows present for EC2, EBS and RDS; docs state the attribution semantics; provenance marks overrides |
| 5 | Model version and manifest, `export-factor-table`, published schema and changelog | M | 2 | Factor table generated for all three providers with percentile columns; schema validated in CI |
| 6 | `packages/provider-reports`: AWS, GCP, Azure ingestion; `CALIBRATION_MODE=report`, then `apply` | L | 3, 5 | Residual table produced for at least one provider on real data; apply mode changes rows only when enabled and stamps `CalibrationVersion` |
| 7 | `export-dataset` with Parquet and CSV to S3, GCS, Azure Blob and local; licence manifest; Ternary integration docs; scheduled-run example | M | 3 (hourly), 6 optional | A Ternary BYOD integration on the EPEX tenant shows carbon next to cost by region and service |
| 8 | Publishing: README and microsite pages, methodology page updates (bases, tiers, calibration), CONTRIBUTING for sources, NOTICE and attribution file, upstream PR candidates identified (hook fixes, hourly grouping), first tagged release | M | 1 to 7 | Fresh clone follows README to a tier-B daily run with no paid data |

Suggested PR granularity inside a phase: interfaces and static source; one source per PR; resolver and wiring; CLI and API; docs. Keep each PR under about 800 changed lines where possible so the hook's test run stays useful.

### Status and order at 2026-11-12

- Phase 0 is done (PR #4).
- Phase 1 is closed.
  - 1a, done (PRs #6 to #9 and #12, hardened in #13 to #15, #17 and #18): the package, the interfaces, the static source, the stores, the resolver, the adapter wired into AWS, GCP and Azure, and provenance on service estimates.
  - 1b, done (PRs #23, #25 and #26): the doctor command and `GET /grid-intensity/capabilities`. Neither needs external credentials. Section 6.5 records how they were built.
  - 1c, cancelled on 2026-11-12 (ADR 0026): the Electricity Maps v4 source. The v3 lookup the fork inherited was removed at the same time, and with it the midnight-sample defect (section 3.3). The acceptance criterion that waited for 1c, a daily run on a real account that shows tier B, is now part of Phase 2's.
- Phase 2 is next. The open sources need no paid data, and the first of them will be the first live data to go through the resolver, which so far has only been exercised by the static source and a fake one.
- The row fields of ADR 0024 are built. The marker of ADR 0025 is merged before the first live source, so that every row estimated from live data carries both.
- Phases 3 to 8 are not started.

## 13. Testing

- **Unit tests** per package with the existing jest setup and coverage thresholds; the new packages set 90 % statements and branches from the start.
- **Contract tests** for every external source use recorded fixtures under `src/__tests__/fixtures/` captured in the spike for that source (request shape, success body, error bodies such as an authentication failure where the source has authentication, empty range). No test calls the network; `global.fetch` is mocked and answers from the recorded fixtures.
- **Resolver tests** cover fallback order, licence gating, retention purging, time-weighting across granularity mismatches and negative caching.
- **Data quality checks** run on fetched points before they are stored: 0 ≤ gCO2e/kWh ≤ 1500, contiguous periods, no overlap, and a gap report per zone.
- **Live smoke** (`GRID_INTENSITY_LIVE_TESTS=true`) runs the doctor against real endpoints; not in CI.
- **End-to-end** (TestCafe) remains as is; the client is unchanged in behaviour.
- **Schema tests** validate the factor table and export against their JSON schemas on every build.

## 14. Verification backlog

Items to confirm against live services before the phase that depends on them. Each becomes a short spike task with its findings recorded in the relevant docs page.

1. Electricity Maps v4 (response field names for `past-range` and `zones`, the accepted `dataCenterProvider` values, what the free tier returns from `/v4/zones`, the terms on caching fetched data). Closed on 2026-11-12 without an answer: Electricity Maps is not used (ADR 0026). What was learned before that is in the ADR: the project's token was refused by the v3 `carbon-intensity/past` endpoint on 2026-11-05 (PR #14).
2. ENTSO-E: that document type A75 (actual generation per production type) is on the free re-use list; token request lead time; per-zone resolution (PT15M vs PT60M). (Phase 2)
   Not answered. The survey of 2026-11-06 (`docs/design/research/2026-11-primary-publishers.md`, section 5) found that CC BY 4.0 was added to the free re-use list on 2022-02-18, but no result showed whether item 16.1.B&C is on the current list, and ENTSO-E's own pages could not be opened. Third-party guides give about three working days for a token, requested by email to transparency@entsoe.eu, which is also where to ask the licence question. Until the answer is in writing the ENTSO-E source declares a licence that needs acknowledgement.
3. EIA: exact route (`electricity/rto/fuel-type-data` assumed), facets (`respondent`, `fueltype`), throttling thresholds. (Phase 2)
   Added by the survey: EIA also publishes hourly CO2 emissions and intensity, for generated and for consumed electricity, in a Grid Monitor spreadsheet per balancing authority, from 2018-07-01 (by the documentation of the PUDL and gridstatus projects; the files were not opened). Check whether the API serves those series, because they would give United States intensity without the factor table.
4. NESO: regional endpoint path and region ids; whether "actual" regional values exist or only forecasts for regions. (Phase 2)
   Closed on 2026-11-10 by the spike in `docs/design/spikes/2026-11-neso.md`: regional values are forecasts only, and actual values exist only in the national series. Section 5.1 carries the result.
5. AWS CUR hourly: whether the EPEX report is hourly; Athena result-set sizes and cost at hourly grouping. (Phase 3)
6. AWS CCFT Data Export: table name, columns, region availability, both accounting methods. (Phase 6)
7. Azure Carbon Optimization: accounting method behind the reported figures; stability of the preview API. (Phase 6)
8. Parquet writer choice for Node without native dependencies, and Ternary's acceptance of its output. (Phase 7)
9. GCP static grid and carbon-free-energy tables: accounting basis and factor type against Google's published method, to replace the `location-production` and `direct` defaults they are labelled with. (Phase 2)
   Added on 2026-11-12: Google's page for these figures (https://cloud.google.com/sustainability/region-carbon) says the hourly grid mix and carbon intensity data behind them is from Electricity Maps. The tables are therefore a place where Electricity Maps data still reaches an estimate, at one remove, and the only one found (ADR 0026). Whether to replace them with factors from the sources the AWS and Azure tables use, or from a primary publisher, changes every Google Cloud estimate in the default configuration, so it is decided with the model version in section 9.
10. MongoDB: the intensity store and the estimates cache against a real server (recovery after a failed first connection, the unique index, a period of 50,000 rows). PRs #13, #15 and #17 record these as checked against mocks only. (Before the first live source)
11. Open sources: how soon after an hour each one publishes a settled value, and whether it revises values later. This sets how long a result stays provisional (ADR 0025). (Phase 2)
12. Survey candidates (section 5.1): for each publisher, the licence on the dataset's own page, the endpoint, the resolution, the depth of the history and the accounting basis. One short spike per publisher, with recorded fixtures, as for NESO. The claims that rest on the weakest evidence are listed in section 6 of `docs/design/research/2026-11-primary-publishers.md`. (Before each source is built)
13. Grid zone registry: each region's zone against the provider's own description of where the region is and the territory of the grid operator. The inherited mappings were never checked. Section 5.5 names one pair that looks inconsistent (AWS `us-east-2` and GCP `us-east5`) and six entries on which an open data centre list differs from the registry. (Before the EIA source)

### Deferred work recorded in pull requests

Found during Phase 1 and left for later. Listed here so that it is not lost in pull request descriptions.

- Alibaba Cloud and on-premise rows, and rows from the cloud usage APIs (billing data turned off), carry no provenance (PR #12). Needed before the export in Phase 7. Rows from the cloud usage APIs, on-premise output and the lookup table (`LookupTableOutput`, the seed of the factor table) also lack the two fields of ADR 0024. Alibaba Cloud rows carry them without provenance, so the factor applied is not in the row. On-premise energy columns are operational energy already, so the export can read them as they are.
- `LocalCacheManager` rewrites the cache file in place, so a write that fails part way leaves a mixed file (PR #15, upstream behaviour). ADR 0025's replace operation closes it.
- `GoogleCloudCacheManager` and `writeToFile` do not wait for `drain` on the GCS write stream, so a slow upload buffers in memory (PR #15, upstream behaviour).
- `DataPersistenceAndCaching.md` says `REACT_APP_PAGE_LIMIT` defaults to 1000; the client and `ConfigurationsGlossary.md` say 50000 (PR #15, rechecked 2026-11-10).
- Whether `estimateCo2` should treat a factor of 0 as 0 instead of as missing (PRs #13 and #18), and the 0 for GCP `europe-north2` in the carbon-free-energy table (section 6.1). Both change estimates, so they are decided with the model version in section 9.
- The running averages that unknown-usage rows are estimated from (`KILOWATT_HOURS_BY_SERVICE_AND_USAGE_UNIT` in each provider's constants) are module-level objects that production code never resets; the tests reset them by hand. In a long-running API server an unknown-usage estimate therefore depends on the requests served before it (found by reading the code on 2026-11-10, upstream behaviour). This works against principle 5 (reproducibility) and is decided with the model version in section 9.

## 15. Risks and mitigations

- **Mixed bases in one number.** Sources differ in accounting basis and factor type, and such figures differ systematically. The NESO spike found NESO consumption-based with direct CO2 factors, and intensity derived from a generation mix is production-based (section 5.3). Mitigation: the basis is a first-class provenance field and the methodology page explains it; summaries can be filtered by basis.
- **Zones with no open publisher.** Without an aggregator (ADR 0026), a grid zone for which no primary publisher offers hourly data under usable terms stays on the static annual factors, tier D. Mitigation: the doctor shows the tier of every region, the catalogue in 5.1 grows one publisher at a time, and the file source takes data a deployment has obtained itself.
- **Contract misunderstanding.** A user could cache or redistribute beyond their terms. Mitigation: retention defaults are conservative for commercial sources, the manifest records what was used, and the export refuses non-redistributable rows by default.
- **Hourly volume.** Local JSON caches will not scale to hourly across many accounts. Mitigation: MongoDB recommended for hourly; row estimates in the docs.
- **Upstream drift.** The fork will diverge from CCF. Mitigation: keep changes additive, PR the generic pieces upstream (section 12, phase 8), and sync trunk from upstream on a schedule.
- **Provider report churn.** The Azure API is preview; AWS Data Exports columns may change. Mitigation: contract tests with fixtures and a version field on each ingester.
- **Scope creep into market-based modelling.** Mitigation: non-goal, stated in the methodology page.

## 16. Open-source packaging

- Licence stays Apache-2.0 (upstream's). `NOTICE` gains the data-source attributions. A `DATA_SOURCES.md` lists each source, its terms and the acknowledgement the tool prints.
- The repository keeps upstream's package names during the programme. Renaming the published packages (or the repository) is a release-time decision for phase 8.
- Changesets drive versioning as upstream does; the first fork release is a major bump of every package whose public types gained provenance fields.
- CONTRIBUTING gains a section "Adding a grid intensity source" (implement the interface, add fixtures, add the source's table of zones keyed by grid zone, declare the licence).

## 17. Glossary

- **Location-based**: emissions from the average intensity of the grid where energy is consumed. **Market-based**: emissions after contractual instruments (PPAs, RECs) are applied. **Production-based**: intensity of what a zone generates. **Consumption-based / flow-traced**: intensity of what a zone consumes, including imports.
- **Lifecycle vs direct factors**: whether upstream emissions of fuels and plant construction are included (lifecycle) or only combustion (direct).
- **Marginal intensity**: emissions of the next unit of demand; a different quantity from average intensity.
- **CFE**: carbon-free energy percentage; Google's hourly matching metric, reflected in CCF's optional CFE-adjusted factors.
- **PUE**: power usage effectiveness, facility energy divided by IT energy.
- **Embodied emissions**: manufacturing emissions of hardware, amortised over its life.
- **FOCUS**: FinOps Open Cost and Usage Specification; v1.4 defines no carbon columns.
- **BYOD**: Ternary's Bring Your Own Data integration.

## Appendix A: new configuration keys

| Key | Default | Purpose |
|---|---|---|
| `GRID_INTENSITY_SOURCES` | `static` | Ordered source list, e.g. `neso,entsoe,eia,file,static` |
| `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` | empty | Comma-separated source ids the operator asserts they are licensed to use |
| `GRID_INTENSITY_STORE` | `LOCAL` | `LOCAL` or `MONGODB` |
| `GRID_INTENSITY_STORE_PATH` | `.ccf/grid-intensity` | LOCAL store directory |
| `GRID_INTENSITY_RETENTION_DAYS_<SOURCE>` | per source default | Retention for `per-contract` sources |
| `GRID_INTENSITY_CAPABILITY_TTL_HOURS` | `24` | Lifetime of probe answers, failures, warnings and `session` points |
| `GRID_INTENSITY_DATASET_DIR` | unset | Directory for BYO dataset files |
| `GRID_INTENSITY_EMISSION_FACTOR_TYPE` | `lifecycle` | Factor table for intensity derived from a generation mix (5.3): `lifecycle` or `direct` |
| `ENTSOE_SECURITY_TOKEN` | unset | |
| `EIA_API_KEY` | unset | |
| `INCLUDE_AVAILABILITY_ZONE` | `false` | Section 8 |
| `PUE_OVERRIDES` | unset | JSON map, section 8 |
| `CALIBRATION_MODE` | `off` | `off`, `report`, `apply` |

`ELECTRICITY_MAPS_TOKEN`, which upstream CCF reads, was removed by ADR 0026. It is ignored, and a warning is logged while it is set, the first time a process resolves grid intensity.

## Appendix B: references

- Survey of primary publishers, 2026-11-06: `docs/design/research/2026-11-primary-publishers.md`
- NESO Carbon Intensity API: https://carbonintensity.org.uk/ (CC BY 4.0)
- ENTSO-E Transparency Platform knowledge base: https://transparency.entsoe.eu/content/static_content/Static%20content/knowledge%20base/knowledge%20base.html
- EIA Open Data API documentation: https://www.eia.gov/opendata/documentation.php and reuse policy: https://www.eia.gov/about/copyrights_reuse.php
- AWS Customer Carbon Footprint Tool, location-based emissions (June 2025): https://aws.amazon.com/about-aws/whats-new/2025/06/customer-carbon-footprint-tool-location-based-emissions/
- Google Cloud Carbon Footprint export schema: https://docs.cloud.google.com/carbon-footprint/docs/data-schema
- Azure Carbon Optimization export API: https://learn.microsoft.com/azure/carbon-optimization/api-export-data
- FOCUS specification v1.4: https://focus.finops.org/wp-content/uploads/2026/06/FOCUS_spec-v1_4.pdf
- Ternary Bring Your Own Data: https://docs.ternary.app/docs/bring-your-own-data-byod and Carbon Footprint: https://docs.ternary.app/docs/carbon-footprint
- CCF methodology: `microsite/docs/HowItWorks/Methodology.md`
