# 26. Grid intensity from primary publishers; Electricity Maps removed

Date: 2026-11-12

## Status

Accepted. Decided by the project owner on 2026-11-08. Amends ADR 0022.

## Decision

The fork does not call Electricity Maps, hold a licence for its data, or build it in as a source.

1. The Electricity Maps v3 lookup inherited from upstream (`getEmissionsFactors` in `packages/common`) is removed, together with `ELECTRICITY_MAPS_TOKEN` and the path in `resolveEmissionsFactors` that ran the lookup ahead of the configured sources.
2. The Electricity Maps v4 source planned as Phase 1c is cancelled. No Electricity Maps source, dataset converter or zone namespace is built.
3. Live grid intensity comes from the organisations that publish the underlying data: system operators, market operators and public agencies, or the official body they publish through. A source built into this repository reads the primary publisher. Services that republish or model that data are not built in. That also covers WattTime, which design section 5.1 listed as an optional later source of marginal intensity: it is not built.
4. The region to zone maps the lookup used are kept, because they record which electricity grid each cloud region is on, and every source needs that. They become the grid zone registry of design section 5.5, in `packages/grid-intensity`, under names that do not refer to Electricity Maps. The zone identifiers do not change.
5. A deployment that holds data from another party can still load it through the file source (design section 5.4) under its own licence acknowledgement. That is the operator's choice and cost. The tool does not depend on it.

## Context

The owner gave the decision in a working session on 2026-11-08, with two reasons: Electricity Maps aggregates data that others publish, so the project can read the publishers themselves, and its API costs money. It was not written into the repository until this record. The documents merged on 2026-11-10 (ADR 0025 and design section 12) were written without it, which is why they still planned the Electricity Maps v4 source.

Six points bear on the decision. Points 2 to 4 were checked for this record on 2026-11-12, in the code as it stood at trunk `2db3b573` and in PR #14. Points 1, 5 and 6 are as they were found at the time, with their source and date; where one was looked at again, it says so. Point 6 was found after the decision and is recorded because it shows what keeping the plan would have needed.

1. Electricity Maps computes its figures from data that system operators and agencies publish. Its open parser repository, `electricitymaps/electricitymaps-contrib`, reads those operators' feeds (read on 2026-11-06 at commit `2faa955a`, for the survey of publishers recorded in `docs/design/research/2026-11-primary-publishers.md`; the review of this record on 2026-11-12 found that commit and, in it, parsers named after operators, such as `ENTSOE.py`, `EIA.py` and `ELEXON.py`). The same inputs are available from their publishers. Design section 5.1 lists the ones the programme builds first: NESO for Great Britain, ENTSO-E for the EU bidding zones and EIA for the United States.
2. The lookup applied one hourly sample, taken at the start of the usage period, to the whole period (`getEmissionsFactors` in `packages/common/src/EmissionsFactors.ts`; design section 3.3 describes it). Rows it served were labelled tier C.
3. It was the one path that went round the source layer (`resolveEmissionsFactors.ts`): it was not subject to licence acknowledgements, it stored nothing, and a failed request stopped the estimation run, where a failed source falls back (design section 6.2).
4. The token available to the project could not use the lookup. On 2026-11-05 the v3 `carbon-intensity/past` endpoint answered HTTP 401 `Request unauthorized for zoneKey=...` for GB, DE, US-CAL-CISO and IN-WE (against the live API, recorded in PR #14). In this project's hands the lookup served no row.
5. Cost. The design document recorded on 2026-11-05, from Electricity Maps' pricing page (https://help.electricitymaps.com/en/articles/13169258-pricing-and-custom-options), a listed price of EUR 6,000 a year for the carbon intensity signal and a free tier for non-commercial use. A web search in a working session on 2026-11-06 found the same price; that search is not recorded in the repository.
6. Phase 1 could not close without a better token. The Electricity Maps v4 source, Phase 1c, needed one that can call `past-range`. A web search of Electricity Maps' own pages on 2026-11-10 found the free tier described as covering the latest and 24-hour history endpoints, with `past` and `past-range` on the commercial plan. That was not checked against the API.

What this decision does not remove:

- The static grid factors for Google Cloud, and their carbon-free-energy variant, are the figures Google publishes for its regions (`getGCPEmissionsFactors` in `packages/gcp/src/domain/GcpFootprintEstimationConstants.ts`, from https://cloud.google.com/sustainability/region-carbon). That page says the hourly grid mix and carbon intensity data behind them is from Electricity Maps (read on 2026-11-12). So every Google Cloud estimate in the default configuration rests on Electricity Maps data at one remove. The figures are constants that upstream CCF took from Google; they cost nothing and call nothing. Replacing them would change every Google Cloud estimate, which makes it a decision for the energy model version (design section 9). Design section 14, item 9, carries it.

What is given up:

- One API that covers more than 130 zones with consumption-based, flow-traced intensity and lifecycle factors.
- A single accounting basis. The primary publishers differ: NESO is consumption-based with direct CO2 factors, and intensity derived from a generation mix is production-based with the factor table the programme chooses (design section 5.3). Provenance carries the basis and the factor type on every row, so the difference is visible, but it is real.
- Coverage of grid zones for which no open hourly publisher has been found. Those stay on the static annual factors, tier D, until one is.
- A built-in source of marginal intensity, which WattTime would have been. The file source still accepts data on a marginal basis (design section 5.4).

Alternatives considered:

- Keep the v3 lookup for deployments that hold a token. It keeps a code path that goes round the source layer, and the sampling defect with it, and nobody on the project can test it against the live service.
- Keep Electricity Maps as an optional source, built later against v4. Recording its fixtures needs a paid or trial token, and it conflicts with the decision to depend on primary publishers. The file source already serves a deployment that has bought data.

## Consequences

- `common` no longer exports `getEmissionsFactors`, `getElectricityMapsData`, `zoneIntensityFactors` or the `mappedRegionsToElectricityMapZones` type, and the configuration has no `ELECTRICITY_MAPS_TOKEN`. That breaks code that imported them, so `common` takes a major version, as do `aws`, `gcp` and `azure`, whose estimates change for a deployment that set the token. `app`, `api` and `cli` take one too, for the same reason: they are what such a deployment runs. The other packages that depend on `common` (`core`, `ali`, `on-premise` and `client`) get the dependency-only patch that changesets computes. An installation that mixes package versions across a major of `common` can therefore still end up with two copies of it, which do not share configuration (`ConfigLoader` keeps it in a module variable). That was already so at the release of 2026-11-05, where `common` went from 2.0.0 to 3.0.0 and `app`, `api` and `cli` took a patch; it is not solved here.
- A deployment that sets `ELECTRICITY_MAPS_TOKEN` gets its estimates from the configured sources: the static annual factors, until a source that covers the region is configured. The variable is ignored. While it is set, a warning is logged the first time a process resolves grid intensity, whether for an estimate, a recommendation, a lookup table or the doctor.
- Rows in an estimates cache that were made with the lookup stay as they are. Nothing estimates a cached period again today (ADR 0025 proposes a refresh), so they stay until the operator deletes the cache. Rows this fork cached name the source in their provenance (`sourceId: 'electricitymaps-v3'`); rows cached by upstream CCF carry no provenance, so nothing marks them.
- Azure goes back to upstream's handling of a subscription whose estimate fails: it logs a warning and leaves the subscription out. The error that made it stop the run no longer exists.
- The capability report and the doctor command show each region's grid zone, where they showed the Electricity Maps zone while a token was set.
- Phase 1 closes with 1a and 1b. The daily run on a real account that shows tier B is Phase 2's acceptance criterion, met from open sources.
- No tier needs a paid subscription. Every intensity the tool applies is a static factor, a value from a primary publisher with a declared licence, or a value from a file the operator supplied. The Google Cloud static factors are the one place found where Electricity Maps data still reaches an estimate, through Google's publication, as the context says. The AWS and Azure tables cite other sources (the methodology page lists them); the Alibaba Cloud table states none in the code and was not traced, and neither was the on-premise table.
- Upstream CCF keeps the integration. A sync from upstream will conflict in the files this removes, and the upstream pull request candidates in Phase 8 no longer include an Electricity Maps v4 source.
