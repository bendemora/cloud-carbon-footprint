---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/common': minor
---

grid-intensity: add the resolver (source order, licence gating, store reads with fetches of missing periods only, time-weighting, negative caching), an in-memory store and the `resolveEmissionsFactors` adapter. Not yet used by the estimation path. common: add the `GRID_INTENSITY` configuration block (`GRID_INTENSITY_SOURCES`, `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS`, `GRID_INTENSITY_CAPABILITY_TTL_HOURS`).
