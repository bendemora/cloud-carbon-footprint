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

With the default configuration the only source is `static`, the default emissions factors described above, and estimates are the ones those factors have always given. Sources that read grid operators and public agencies directly are being added, starting with NESO for Great Britain; `docs/design/2026-11-localised-time-resolved-carbon-estimation.md` in the repository has the plan.

| Variable                                  | Default               | Notes                                                                                                                              |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GRID_INTENSITY_SOURCES`                  | `static`              | Source ids in order of preference, comma separated. Only `static` exists so far. An id that is not known is ignored, with a warning. |
| `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` | empty                 | Source ids you state you are licensed to use. Needed for a source whose licence is commercial, non-commercial or custom.            |
| `GRID_INTENSITY_STORE`                    | `LOCAL`               | Where fetched intensity values are kept: `LOCAL` (JSON files) or `MONGODB` (uses `MONGODB_URI` and `MONGODB_CREDENTIALS`).          |
| `GRID_INTENSITY_STORE_PATH`               | `.ccf/grid-intensity` | Directory of the `LOCAL` store.                                                                                                    |
| `GRID_INTENSITY_CAPABILITY_TTL_HOURS`     | `24`                  | How long CCF remembers what a source said it can deliver, and a source's failures.                                                 |

### Electricity Maps is no longer called

Upstream CCF can replace the default factor with a value from the Electricity Maps API. This fork has removed that integration (`.adr/0026-grid_intensity_from_primary_publishers.md` in the repository): it does not call Electricity Maps, and no setting turns it back on.

If your configuration still sets `ELECTRICITY_MAPS_TOKEN`:

- The variable is ignored. CCF logs one warning that says so the first time it resolves a grid emissions factor: for estimates, recommendations and lookup tables, and when the doctor below runs. A request answered wholly from the estimates cache resolves nothing and logs nothing.
- Estimates use the sources in `GRID_INTENSITY_SOURCES`, which means the default emissions factors unless you have configured another source. Expect the figures for regions that had an Electricity Maps value to change.
- Estimates already in your cache are not touched, and CCF does not estimate a cached period again by itself. A cached row that was made with an Electricity Maps value keeps it until you delete the cache; see [Data Persistence and Caching](DataPersistenceAndCaching.md). Rows this fork cached name the source `electricitymaps-v3` in their `provenance`. Rows cached by upstream CCF carry no provenance, so nothing marks them.
- Remove the variable from your `.env` file, and from your Docker secrets if you set it there, to stop the warning.

One thing is unchanged. The default factors for Google Cloud regions are the figures Google publishes, and Google says it calculates them from Electricity Maps data. CCF reads them as constants and calls nothing.

### Where each estimate's factor came from

AWS, Google Cloud and Azure service estimates computed from billing data (Cost and Usage Reports, the billing export and Consumption Management) carry a `provenance` object in the API response. It names the factor's source (`static` for the default factors) and the source's zone. It also gives the granularity, accounting basis and licence of the data, a quality tier from A (hourly data for hourly usage) to D (the static annual factors), and `gCO2ePerKWh`, the grid intensity applied to the row. A row's `kilowattHours` includes its embodied emissions converted to energy at that same factor, so for every row with a `co2e` value, `co2e` in tonnes is `kilowattHours` times `gCO2ePerKWh` divided by 1,000,000. (An AWS row whose instance type CCF cannot size has no `co2e`, an upstream limitation.)

The same rows, and Alibaba Cloud rows from billing data, also say how much of the estimate is electricity and how much is embodied emissions. `operationalKilowattHours` is the electricity the usage is modelled to consume. `embodiedCo2e` is the metric tons of CO2e from hardware manufacturing attributed to the usage, which does not depend on the grid. `co2e` is `operationalKilowattHours` times `gCO2ePerKWh` divided by 1,000,000, plus `embodiedCo2e`, at any grid intensity. `kilowattHours` keeps the value it has always had, for tools that read it, but it is not only electricity: it includes the embodied emissions turned into energy at the row's grid factor, so the same usage shows more of it when the grid is cleaner. Read `operationalKilowattHours` when you need energy.

Estimates from the cloud usage APIs (billing data turned off), rows cached before the upgrade, and Alibaba Cloud and on-premise estimates do not carry it. Provenance roughly doubles the size of each service estimate in the API response and in the estimates cache. Neither the API response nor the MongoDB cache has a size limit that this affects. With the JSON file cache (local filesystem or Google Cloud Storage), one period's estimates must stay under about 512 MiB of JSON, and provenance halves the number of rows that fit, to about 1.1 million. The two fields above lower that to about 950,000; see [Data Persistence and Caching](DataPersistenceAndCaching.md).

### Checking what your configuration can deliver

The grid intensity doctor reports, for every AWS, Google Cloud and Azure region, the electricity grid the region is on and what each configured grid intensity source can deliver for it. It needs no cloud credentials and asks no source for data. A provider whose estimates are turned off (for example `AWS_INCLUDE_ESTIMATES=false`) is left out.

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
- A row whose factor could still improve carries `isProvisional: true` in its `provenance`. That happens when a source had not published the whole usage period yet, when its values were preliminary, or when a source that comes earlier in `GRID_INTENSITY_SOURCES` could not be reached and a later one answered. The quality tier is the one the row has now. CCF does not estimate a cached period again by itself, so a provisional row stays as it is until you delete the cache. With the default configuration no row is provisional.
- Every source has a licence. Its attribution text is listed by the doctor, and a source with a commercial, non-commercial or custom licence is not used until you acknowledge it.
