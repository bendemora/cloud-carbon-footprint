---
id: emissions-factors
title: Emissions Factors
slug: /emissions-factors
sidebar_position: 5
---

## Carbon Intensity Emissions Factors

Carbon Intensity Emissions Factors are values that represent the amount of carbon dioxide equivalent (CO2e) emissions produced per unit of energy consumed. These factors vary depending on factors like energy source and geographical region. CCF utilizes these factors to estimate emissions associated with cloud infrastructure energy consumption.
We provide more detailed information in our [methodology](https://www.cloudcarbonfootprint.org/docs/methodology#carbon-estimates-co2e) on how the tool uses carbon intensity emissions factors and how the defaults are sourced.

### Default Emissions Factors

CCF comes with a set of default emissions factors that are sourced from publicly available data sources such as government agencies, energy organizations, and research institutions. These default factors provide a reasonable estimate of carbon intensity for different energy sources and regions and are used when no specific configuration is provided.
For reference, we have the default grid emissions factors located [here](https://www.cloudcarbonfootprint.org/docs/methodology#appendix-v-grid-emissions-factors) in the appendix of the Methodology.

### Grid intensity sources

CCF resolves the carbon intensity for each estimate through a source layer. Each source says what it can deliver for a grid zone (how fine its data is, how far back it goes, its accounting basis and its licence), and for each usage period CCF uses the best source that covers it. The sources are listed in `GRID_INTENSITY_SOURCES`, in order of preference.

With the default configuration the only source is `static`, the default emissions factors described above, and estimates are the ones those factors have always given. Sources that read grid operators and public agencies directly are being added. The first is `neso`, for Great Britain, described below; `docs/design/2026-11-localised-time-resolved-carbon-estimation.md` in the repository has the plan for the others.

| Variable                                  | Default               | Notes                                                                                                                              |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GRID_INTENSITY_SOURCES`                  | `static`              | Source ids in order of preference, comma separated. `static` and `neso` exist so far. An id that is not known is ignored, with a warning. |
| `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` | empty                 | Source ids you state you are licensed to use. Needed for a source whose licence is commercial, non-commercial or custom.            |
| `GRID_INTENSITY_STORE`                    | `LOCAL`               | Where fetched intensity values are kept: `LOCAL` (JSON files) or `MONGODB` (uses `MONGODB_URI` and `MONGODB_CREDENTIALS`).          |
| `GRID_INTENSITY_STORE_PATH`               | `.ccf/grid-intensity` | Directory of the `LOCAL` store.                                                                                                    |
| `GRID_INTENSITY_CAPABILITY_TTL_HOURS`     | `24`                  | How long CCF remembers what a source said it can deliver, and a source's failures.                                                 |

### NESO for Great Britain

The `neso` source reads the Carbon Intensity API of the National Energy System Operator (NESO), which runs the electricity system of Great Britain. The API is public. It needs no registration and no key.

To use the source, list it ahead of the default factors:

```
GRID_INTENSITY_SOURCES=neso,static
```

- **What it covers.** AWS `eu-west-2`, Azure `uksouth` and `ukwest` (and the Azure location `uk`), and Google Cloud `europe-west2`, from 11 September 2017. Every other region goes on using the default factors.
- **What it reads.** NESO's national series of outturn values, which its API calls "actual". NESO publishes one for each half hour. CCF averages the two half hours of each hour, and averages those hours over the usage period of each estimate. It does not use NESO's forecasts.
- **What the numbers are.** Consumption-based: the electricity generated in Great Britain and imported into it, over demand, corrected for transmission losses. NESO's factors are direct CO2 from generation, so the values are grams of CO2 per kWh, not CO2e. The `provenance` of each row says so (`basis` is `location-consumption` and `factorType` is `direct`). Expect the figures for these regions to change when you turn the source on: the default factor is one annual figure, and the NESO value is the one for the period. For Google Cloud `europe-west2` the NESO value is used whether or not `GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE` is set, because that setting changes the default factors only.
- **Quality tier.** B: hourly data averaged over a day or longer of usage. Tier A needs hourly usage, which CCF does not produce yet.
- **How recent the data is.** CCF asks NESO for an hour two hours after the hour has ended, because NESO can still change a value shortly after it first publishes it. An estimate for a day that has not ended, or that ended less than two hours ago, uses the hours it can get and is marked estimated (tier C) and provisional (`isProvisional`), so it can be told apart and estimated again later. A long-running API server asks again within the hour whether NESO has newer hours.
- **When NESO cannot be reached, or answers with an error.** CCF logs one warning, uses the default factors for the hours it has not stored, and asks NESO again after `GRID_INTENSITY_CAPABILITY_TTL_HOURS`. The `provenance` of the rows estimated from the default factors names `static` as their source and marks them `isProvisional`.
- **Storage.** The hours CCF has fetched are kept in the store that `GRID_INTENSITY_STORE` selects, so an hour is fetched once.
- **Requests.** CCF sends NESO one request at a time, at least a second apart, because NESO limits the rate of requests and publishes no figure. A day of usage is one request. The first estimate of a long period therefore waits about a second per day of Great Britain usage, about six minutes for a year; after that the hours are in the store.
- **Licence.** CC BY 4.0. It needs no acknowledgement. The doctor below lists the attribution text, which is: "Contains data from the Carbon Intensity API by National Energy System Operator (NESO), https://carbonintensity.org.uk, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Half-hourly values averaged to hours." Show it wherever you publish figures made with this source.
- **Known limitation.** The value is the national figure for Great Britain, not a figure for the place a data centre is in. NESO also publishes regional figures, but they are forecasts with no measured value behind them, and the cloud providers name only a metropolitan area for their regions. NESO's regional model put London about a quarter above the national figure in the first half of October 2026, so the national figure may understate the carbon intensity of electricity used there.

This source is tested against responses recorded from NESO's API on 10 November 2026. It has not yet been run against the live API. The doctor described below checks that your deployment can reach NESO. With `neso` configured it prints a second row for every region. The rows of the Great Britain regions show the source zone `national` and tier B, and their Error column says why if NESO cannot be reached. Every other region shows `unavailable` for `neso`. In the first three hours of a UTC day the last 24 hours can show tier C, or a percentage after the tier, because the hours that have just ended are held back.

### Electricity Maps is no longer called

Upstream CCF can replace the default factor with a value from the Electricity Maps API. This fork has removed that integration (`.adr/0026-grid_intensity_from_primary_publishers.md` in the repository): it does not call Electricity Maps, and no setting turns it back on.

If your configuration still sets `ELECTRICITY_MAPS_TOKEN`:

- The variable is ignored. CCF logs one warning that says so the first time it resolves a grid emissions factor: for estimates, recommendations and lookup tables, and when the doctor below runs. A request answered wholly from the estimates cache resolves nothing and logs nothing.
- Estimates use the sources in `GRID_INTENSITY_SOURCES`, which means the default emissions factors unless you have configured another source. Expect the figures for regions that had an Electricity Maps value to change.
- Estimates already in your cache are not touched, and CCF does not estimate a cached period again by itself. A cached row that was made with an Electricity Maps value keeps it until you delete the cache; see [Data Persistence and Caching](DataPersistenceAndCaching.md). Rows this fork cached name the source `electricitymaps-v3` in their `provenance`. Rows cached by upstream CCF carry no provenance, so nothing marks them.
- Remove the variable from your `.env` file, and from your Docker secrets if you set it there, to stop the warning.

One thing is unchanged. The default factors for Google Cloud regions are the figures Google publishes, and Google says it calculates them from Electricity Maps data. CCF reads them as constants and calls nothing.

### Where each estimate's factor came from

AWS, Google Cloud and Azure service estimates computed from billing data (Cost and Usage Reports, the billing export and Consumption Management) carry a `provenance` object in the API response. It names the factor's source (`static` for the default factors) and the source's zone. It also gives the granularity, accounting basis and licence of the data, a quality tier from A (hourly data for hourly usage) to D (the static annual factors), and `gCO2ePerKWh`, the grid intensity applied to the row. A row's `kilowattHours` includes its embodied emissions converted to energy at that same factor, so for a row with a `co2e` value, `co2e` in tonnes is `kilowattHours` times `gCO2ePerKWh` divided by 1,000,000. The exception is a row merged from parts whose factors came from different sources, which is marked `isEstimated`: its `gCO2ePerKWh` is the intensity of its electricity. (An AWS row whose instance type CCF cannot size has no `co2e`, an upstream limitation.)

The same rows, and Alibaba Cloud rows from billing data, also say how much of the estimate is electricity and how much is embodied emissions. `operationalKilowattHours` is the electricity the usage is modelled to consume. `embodiedCo2e` is the metric tons of CO2e from hardware manufacturing attributed to the usage. For usage CCF can size it does not depend on the grid. For AWS and Azure usage that CCF estimates from the average of known usage, it is the share of the estimate that comes from the embodied emissions of the known rows, and it moves with the grid factors (a known fault, recorded in ADR 0024). `co2e` is `operationalKilowattHours` times `gCO2ePerKWh` divided by 1,000,000, plus `embodiedCo2e`, at any grid intensity. `kilowattHours` keeps the value it has always had, for tools that read it, but it is not only electricity: it includes the embodied emissions turned into energy at the row's grid factor, so the same usage shows more of it when the grid is cleaner. Read `operationalKilowattHours` when you need energy.

Provenance is not on estimates from the cloud usage APIs (billing data turned off), on rows cached before it was recorded, or on Alibaba Cloud and on-premise estimates. The two fields are not on estimates from the cloud usage APIs, on on-premise output, on a row with no `co2e` value, or on rows cached before they were recorded. A cached period keeps its rows until you delete the cache. Provenance roughly doubles the size of each service estimate in the API response and in the estimates cache. Neither the API response nor the MongoDB cache has a size limit that this affects. With the JSON file cache (local filesystem or Google Cloud Storage), one period's estimates must stay under about 512 MiB of JSON, and provenance halves the number of rows that fit, to about 1.1 million. The two fields above lower that to about 950,000; see [Data Persistence and Caching](DataPersistenceAndCaching.md).

### Checking what your configuration can deliver

The grid intensity doctor reports, for every AWS, Google Cloud and Azure region, the electricity grid the region is on and what each configured grid intensity source can deliver for it. It needs no cloud credentials and fetches no intensity data. It does check that each source can be reached, which for `neso` is one small request to NESO's API. A provider whose estimates are turned off (for example `AWS_INCLUDE_ESTIMATES=false`) is left out.

```sh
yarn workspace @cloud-carbon-footprint/cli grid-intensity-doctor
```

It prints one row per region and source. With the default configuration the only source is `static`, the default emissions factors. Four of its rows:

```
| Provider | Region                  | Grid zone    | Source | Source zone                 | Last 24 hours | Last 30 days | Last 12 months | Licence | Error
| AWS      | us-east-1               | US-MIDA-PJM  | static | aws:us-east-1               | D             | D            | D              | open    |
| AWS      | eu-west-2               | GB           | static | aws:eu-west-2               | D             | D            | D              | open    |
| GCP      | europe-west2            | GB           | static | gcp:europe-west2            | D             | D            | D              | open    |
| AZURE    | uksouth                 | GB           | static | azure:uksouth               | D             | D            | D              | open    |
```

- **Grid zone** is the electricity grid the region is on: a country code, followed by a grid area where the grid is divided (`GB`, `US-MIDA-PJM`). It is `-` when CCF has no grid zone for the region, which then uses the default factors only.
- **Source zone** is the name the source has for the zone it would use for the region, or `-` when it has none.
- **Last 24 hours**, **Last 30 days** and **Last 12 months** give the best quality tier the source can deliver for a day of usage in that window, from A to D as described above, or `-` when it can deliver none. A day is the finest usage period CCF produces, so hourly data shows as tier B. A percentage after the tier is the share of the days in the window that the source can serve, shown when that is not all of them.
- **Licence** is `open`, `acknowledged`, `needs-acknowledgement` or `unavailable`. A source whose licence needs acknowledgement is not used until it is listed in `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS`. `unavailable` means the source has no zone or no data for the region.
- **Error** shows a probe of the source that failed, or the reason CCF has stopped asking the source for that zone.

Below the table the doctor lists the attribution text of each source.

The API serves the same report as JSON at `GET /api/grid-intensity/capabilities`.

### Additional Notes

- A region that no configured source covers, or whose source has no data for the period, uses the default emissions factors. The `provenance` of each row and the doctor both show when that is the case.
- A row whose factor could still improve carries `isProvisional: true` in its `provenance`. That happens when a source had not published the whole usage period yet, when its values were preliminary, or when a source could not be reached, whether that is the source the factor came from or one that would have been preferred to it. The quality tier is the one the row has now. CCF does not estimate a cached period again by itself, so a provisional row stays as it is until you delete the cache. With the default configuration no row is provisional.
- Every source has a licence. Its attribution text is listed by the doctor, and a source with a commercial, non-commercial or custom licence is not used until you acknowledge it.
