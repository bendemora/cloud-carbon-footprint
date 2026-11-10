---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/app': minor
'@cloud-carbon-footprint/aws': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
---

app: add `App.getGridIntensityCapabilities()`, the grid intensity capability report for every region in the AWS, GCP and Azure region tables (a provider with `<PROVIDER>_INCLUDE_ESTIMATES=false` is left out). grid-intensity: add `createCapabilityReporter`, which builds the report on the default resolver from the configuration. While `ELECTRICITY_MAPS_TOKEN` is set, the report states that the Electricity Maps v3 lookup is in use, that it yields tier C for daily and longer usage, and each region's Electricity Maps zone; it does not call Electricity Maps. aws, gcp, azure: export the region tables and the region to Electricity Maps zone maps (`AWS_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES`, `GCP_REGIONS`, `GCP_DUAL_REGIONS`, `GCP_MULTI_REGIONS`, `GCP_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES`, `AZURE_REGIONS`, `AZURE_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES`). Estimates are unchanged.
