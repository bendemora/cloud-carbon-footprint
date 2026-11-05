---
'@cloud-carbon-footprint/common': major
'@cloud-carbon-footprint/core': major
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/aws': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
---

Service estimates carry provenance. `ServiceData` and `FootprintEstimate` gain an optional `provenance` (source, grid zone, granularity, basis, factor type, estimated flag, licence, quality tier, the gCO2e/kWh applied, model version). The `Provenance` type and its literal types now live in `common` and are re-exported by `grid-intensity`; `Provenance` gains `gCO2ePerKWh`. AWS, GCP and Azure attach it to every billing row. Unknown-usage rows now resolve grid intensity like other rows; with the default configuration this changes nothing, and with `ELECTRICITY_MAPS_TOKEN` set they now use the same Electricity Maps value as the known rows of the same region and day instead of the static factor. `common` and `core` take a major bump, as the design specifies for packages whose public types gained provenance fields. Provenance roughly doubles the size of each service estimate in API responses and in the estimates cache (about 250 more bytes of JSON per row with the default factors). With the LOCAL or GCS cache, one period's estimates must still fit in one string of about 512 MiB, so that limit falls from about 2.3 million rows to about 1.1 million; the API response and the MongoDB cache no longer have a limit of this kind.
