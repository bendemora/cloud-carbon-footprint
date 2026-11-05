---
'@cloud-carbon-footprint/grid-intensity': patch
'@cloud-carbon-footprint/core': patch
'@cloud-carbon-footprint/common': patch
'@cloud-carbon-footprint/azure': patch
'@cloud-carbon-footprint/api': patch
---

Fixes from a review of the Phase 1 grid intensity work. With `ELECTRICITY_MAPS_TOKEN` set, an invalid token (HTTP 401 with `Invalid auth-token`) or an Electricity Maps server error (HTTP 5xx) now fails the request like a network error, instead of falling back to the default factors row by row and caching those rows. A 401 for a zone or endpoint the token has no access to still falls back for that zone, as before; the error is an `ElectricityMapsRequestError`, and Azure no longer skips the subscription when it sees one, so the run stops and nothing partial is cached. A region whose static factor is 0 (GCP `europe-north2` with `GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE=true`) now gets provenance for the Unknown zone and factor that `estimateCo2` applies, instead of 0 gCO2e/kWh; the estimate itself is unchanged. The static factors are no longer checked against the 0 to 1500 gCO2e/kWh bounds meant for fetched data, which logged a misleading "Dropped 1 point" warning for GCP multi-regions; estimates are unchanged. With `GRID_INTENSITY_STORE=MONGODB`, a malformed `MONGODB_URI` or a missing `MONGODB_CREDENTIALS` file now logs a warning, without the user name or password from `MONGODB_URI`, and keeps points in memory instead of failing every AWS, GCP and Azure estimate. When rows with different provenance are merged into one service estimate, the merged row takes the more restrictive of their licences. The API's deployment package now includes `grid-intensity` instead of expecting it from npm.
