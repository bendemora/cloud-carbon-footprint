---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/aws': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
'@cloud-carbon-footprint/cli': patch
'@cloud-carbon-footprint/api': patch
---

The AWS, GCP and Azure packages resolve grid intensity through `resolveEmissionsFactors` from `@cloud-carbon-footprint/grid-intensity` instead of `getEmissionsFactors`. With the default configuration, estimates are unchanged. With `ELECTRICITY_MAPS_TOKEN` set, the existing Electricity Maps v3 lookup is still used, with two differences: a failed request falls back to the default factors with one warning per region instead of failing the run, and recommendations and lookup tables use the previous UTC day instead of the current hour. The CLI and the API's shutdown handler close the grid intensity store.
