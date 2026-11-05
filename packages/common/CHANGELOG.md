# @cloud-carbon-footprint/common

## 3.0.0

### Major Changes

- fd33210: Service estimates carry provenance. `ServiceData` and `FootprintEstimate` gain an optional `provenance` (source, grid zone, granularity, basis, factor type, estimated flag, licence, quality tier, the gCO2e/kWh applied, model version). The `Provenance` type and its literal types now live in `common` and are re-exported by `grid-intensity`; `Provenance` gains `gCO2ePerKWh`. AWS, GCP and Azure attach it to every billing row. Unknown-usage rows now resolve grid intensity like other rows; with the default configuration this changes nothing, and with `ELECTRICITY_MAPS_TOKEN` set they now use the same Electricity Maps value as the known rows of the same region and day instead of the static factor. `common` and `core` take a major bump, as the design specifies for packages whose public types gained provenance fields. Provenance roughly doubles the size of each service estimate in API responses and in the estimates cache (about 250 more bytes of JSON per row with the default factors). With the LOCAL or GCS cache, one period's estimates must still fit in one string of about 512 MiB, so that limit falls from about 2.3 million rows to about 1.1 million; the API response and the MongoDB cache no longer have a limit of this kind.

### Minor Changes

- fd49e2b: grid-intensity: add the resolver (source order, licence gating, store reads with fetches of missing periods only, time-weighting, negative caching), an in-memory store and the `resolveEmissionsFactors` adapter. A source counts as fine enough when its data is no coarser than the usage period (daily for a week, monthly for a quarter). Stored points are used regardless of the source's lookback window or recent failures, which limit fetches only. A source covering only part of a period is a fallback: a later source that covers the whole period wins, except the static source over partial live data. A day running past the end of a source's data is served from its finest data up to that point, marked estimated. Points that are not whole UTC periods of the requested granularity and zone are dropped. Warnings repeat at most once per source, zone and kind per capability TTL, and `session`-retention points are kept in memory until the first resolve call after the TTL. A resolved 0 gCO2e/kWh gives 0 emissions rather than NaN. common: add the `GRID_INTENSITY` configuration block (`GRID_INTENSITY_SOURCES`, `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS`, `GRID_INTENSITY_CAPABILITY_TTL_HOURS`).
- 241cdd9: grid-intensity: add the LOCAL (JSON files) and MONGODB intensity stores, selected by `GRID_INTENSITY_STORE` for the default resolver, and `shutdownDefaultResolver()` to close the store at the end of a run. The static source is never stored. Overlapping writes to one LOCAL file within a process are serialised and keep every point; ids that differ only in case are never mixed on case-insensitive file systems; `purge` skips files the store did not write and removes stale temporary files. The MONGODB store tries to connect again five minutes after a failed connection. common: add `GRID_INTENSITY_STORE` and `GRID_INTENSITY_STORE_PATH` to the `GRID_INTENSITY` configuration block.

### Patch Changes

- be5c136: Fixes from a review of the Phase 1 grid intensity work. With `ELECTRICITY_MAPS_TOKEN` set, an invalid token (HTTP 401 with `Invalid auth-token`) or an Electricity Maps server error (HTTP 5xx) now fails the request like a network error, instead of falling back to the default factors row by row and caching those rows. A 401 for a zone or endpoint the token has no access to still falls back for that zone, as before; the error is an `ElectricityMapsRequestError`, and Azure no longer skips the subscription when it sees one, so the run stops and nothing partial is cached. A region whose static factor is 0 (GCP `europe-north2` with `GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE=true`) now gets provenance for the Unknown zone and factor that `estimateCo2` applies, instead of 0 gCO2e/kWh; the estimate itself is unchanged. The static factors are no longer checked against the 0 to 1500 gCO2e/kWh bounds meant for fetched data, which logged a misleading "Dropped 1 point" warning for GCP multi-regions; estimates are unchanged. With `GRID_INTENSITY_STORE=MONGODB`, a malformed `MONGODB_URI` or a missing `MONGODB_CREDENTIALS` file now logs a warning, without the user name or password from `MONGODB_URI`, and keeps points in memory instead of failing every AWS, GCP and Azure estimate. When rows with different provenance are merged into one service estimate, the merged row takes the more restrictive of their licences. The API's deployment package now includes `grid-intensity` instead of expecting it from npm.

## 2.0.0

### Major Changes

- b05c4ba: Upgraded the node to 24, jest and eslint.

## 1.15.0

### Minor Changes

- 7e899dce: Adds support and configuration variables for filtering accounts/projects by id

## 1.14.0

### Minor Changes

- 0976d8cf: Add support for authenticating with Azure using an SPN and a cetificate instead of a client secret

## 1.13.2

### Patch Changes

- 9737749f: Fixes issue with unit conversions for Electricity Map Carbon Intensity values

## 1.13.1

### Patch Changes

- db1b66fe: fixes console warning in common

## 1.13.0

### Minor Changes

- 6ffe7497: adds electricity maps api handling. For CLI create-app template changes, refer to [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/2749723c00343865c7453fea29609ea6dad4b5e9).

### Patch Changes

- bc06b861: Fixes issue when asserting set values of INCLUDE_ESTIMATES config
- 7630768d: updates default for include estimates config

## 1.12.0

### Minor Changes

- 1a5d7636: Adds support for listing Azure subscription IDs to fetch
- c82bf5fd: Adds config support for chunking/splitting azure requests by subscription

## 1.11.0

### Minor Changes

- 0d20b32c: Adds support for Google Cloud resource tags to configuration options

## 1.10.0

### Minor Changes

- 3f17990d: Add option to chunk time range in azure requests to avoid infinite rate limit retries

### Patch Changes

- 1d297700: adds support for aws china during aws account authorization

## 1.9.0

### Minor Changes

- 689c973e: Add support for Azure Tags and resource groups

### Patch Changes

- 689c973e: Adds config and default values for including individual cloud providers
- 689c973e: removes usageUnit from lookup table result
  Please refer to [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/dca81101d2b6d33beef2385faea6cf76bda3484f) for create app template updates

## 1.8.0

### Minor Changes

- a6423a68: Aggregate footprint estimates for AWS resources by tags.

### Patch Changes

- a6423a68: updates ts-node dependency
- a6423a68: Correctly calculate period end date when the local timezone switched into or out of DST during the period

## 1.7.0

### Minor Changes

- a7a79c83: Updates emissions factors for cloud provider regions

## 1.6.0

### Minor Changes

- cd239fc2: updates on-premise usage hours up time approach. Update create-app templates referenced [here](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/3568e74165e73343bfd579c544f6f3de7f3cdcec)

## 1.5.1

### Patch Changes

- 510d4b86: updates packages: axios googleapis dotenv @types/jest-when

  See [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/8d8c1db6ff94da5127d559e10632479a8520c67a) for changes to the create-app templates.

- ff05607b: Bumps to latest version of typescript and sets resolution for this

  See [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/6cdc1469dcd5380c9c8a84b9fe13b977991db54c) for changes to the create-app templates.

## 1.5.0

### Minor Changes

- 7ecd432d: Adds support for optionally passing in the CCF Config into the api router
- 9fcbfc67: Adds option for receiving all recommendation services
- 9938c9b0: refactors ccf for v1 implementation of on-premise estimations
  Refer to [this](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/b3ba4120d633a8b83bf8bc0c131855dd67e6a288) commit to update cli package templates.

## 1.4.0

### Minor Changes

- f40ce29e: Adds Compute Optimizer Recommendations for AWS
- 04f2be16: Adds configurable option to use Google's published carbon free energy % in emissions factors. Updates estimation logic for GCP services: Cloud Composer and Kubernetes Engine, to improve accuracy.

## 1.3.1

### Patch Changes

- 8fd171ed: Updates a number of packages and fixes linting, typescript and dependency issues

## 1.3.0

### Minor Changes

- c29a3b53: Adds support for specifying groupBy via API param and for displaying line chart data according to data grouping

  For changes to create-app templates, please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/8743e9a36f005716095300b7a1f331b4ffaa8100).

## 1.2.1

### Patch Changes

- a304acb6: Upgrades version of typescript to 4.5.3

## 1.2.0

### Minor Changes

- f3569daa: Updates emissions factor api response to include cloud provider

  For create-app template updates, please refer to [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/c19cca55d4c095d81f0bb80745580741d73405b5)

- 61332214: Adds CLI command for creating a lookup table to be used in ETL pipelines
- 52237bc6: Adds additional dashboard for viewing cloud provider recommendations including refactoring filters for reusability

  For updating the create-app templates, please refer to the following [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/d1f9a94ea88e6f9210a781e16df18b9f64a0b03d).

## 1.1.0

### Minor Changes

- f75cf08f: Adds support for getting GCP recommendations from the API
- 52a8b3c1: Adds support for specifying recommendation target for AWS via API parameter

  Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/404c77796ae838766dc8007e18daee2c7526f6ed) to update create app templates.

## 1.0.0

### Major Changes

- 91ed3d75: Update variables GCP_BILLING_ACCOUNT_ID/GCP_BILLING_ACCOUNT_NAME to be GCP_BILLING_PROJECT_ID/GCP_BILLING_PROJECT_NAME

  This is a major update for packages: api, cli, common. Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/aab00ea5a395d94ba5ce1424ffa33abbafd7ed58) for create-app template updates as they are breaking changes.

### Minor Changes

- 13f39ac7: implements recommendations for aws rightsizing recommendations api

  Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/b2181a1942b0910613c8b15f97d074a7be6100b8) to update create app templates.

- 72fc2752: Removed unnecessary config option: targetRoleSessionName
- e76d5fdd: Adds accountId to the Estimation Results returned from the Cloud Carbon Footprint API

  Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/cd2d5b988544246d87abbc441895d76003fed72b) to update create app templates.

### Patch Changes

- bbceed8b: Updates dependencies: @types/fs-extra, typescript, husky and @types/node

## 0.0.3

### Patch Changes

- e93d31ec: Extracts common data from cloud providers
- 3b42775b: Updates @types/node to 15.12.4
- 53366130: add dot env dep to common and update logger on azure

## 0.0.2

### Patch Changes

- 8e24c32b: fixes dist directory to be added to published packages
