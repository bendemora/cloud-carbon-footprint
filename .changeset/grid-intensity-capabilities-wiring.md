---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/app': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
---

app: add `App.getGridIntensityCapabilities()`, the grid intensity capability report for every region in the AWS, GCP and Azure region tables (a provider with `<PROVIDER>_INCLUDE_ESTIMATES=false` is left out). grid-intensity: add `createCapabilityReporter`, which builds the report on the default resolver from the configuration. gcp, azure: export the region tables (`GCP_REGIONS`, `GCP_DUAL_REGIONS`, `GCP_MULTI_REGIONS`, `AZURE_REGIONS`). Estimates are unchanged.
