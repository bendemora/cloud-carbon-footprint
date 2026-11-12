---
'@cloud-carbon-footprint/common': major
'@cloud-carbon-footprint/aws': major
'@cloud-carbon-footprint/gcp': major
'@cloud-carbon-footprint/azure': major
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/app': major
'@cloud-carbon-footprint/api': major
'@cloud-carbon-footprint/cli': major
'@cloud-carbon-footprint/create-app': patch
---

Electricity Maps is no longer called (ADR 0026). common: `getEmissionsFactors`, `getElectricityMapsData`, `zoneIntensityFactors` and the `mappedRegionsToElectricityMapZones` type are removed, and the configuration no longer has `ELECTRICITY_MAPS_TOKEN`; it gains `REMOVED_SETTING_WARNINGS`, one warning for each removed setting that is still set. aws, gcp, azure: estimates no longer take a grid emissions factor from Electricity Maps when `ELECTRICITY_MAPS_TOKEN` is set. They use the sources in `GRID_INTENSITY_SOURCES`, which by default are the static annual factors, so the figures of a deployment that set the token change; with the default configuration estimates are unchanged. The region to zone maps in `AWSRegions.ts`, `GCPRegions.ts` and `AzureRegions.ts` move, unchanged, to the grid zone registry in grid-intensity. Azure billing data again leaves out a subscription whose estimate fails, with a warning, as upstream does. grid-intensity: add the grid zone registry (`GRID_ZONES`, `gridZoneOf`, `GRID_ZONE_REGISTRY_VERSION`), which says which electricity grid each AWS, GCP and Azure region is on. `ElectricityMapsRequestError`, `isElectricityMapsRequestError`, `LEGACY_ELECTRICITY_MAPS_SOURCE_ID` and the `legacyElectricityMapsZones` and `logger` options of `resolveEmissionsFactors` are removed. While `ELECTRICITY_MAPS_TOKEN` is set, a warning is logged when the default resolver is built: once in a CLI run and once in the life of an API server, whether the first use is an estimate, a recommendation, a lookup table or the doctor. The warning is also given when a configuration object handed to `setConfig` or `createRouter` carries the token as a property of its own. `setConfig` then stores a copy of the object with the warning added; an object with no removed setting is stored as it is. app, api, cli: they take a major for the same reason as aws, gcp and azure: they are what a deployment runs, and the figures of one that set the token change. app: the `Using Electricity Maps` log line is gone. api, cli, create-app: the `.env` templates no longer offer `ELECTRICITY_MAPS_TOKEN`. Rows already in an estimates cache keep their values until the cache is deleted.
