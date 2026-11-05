---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/common': minor
---

grid-intensity: add the LOCAL (JSON files) and MONGODB intensity stores, selected by `GRID_INTENSITY_STORE` for the default resolver, and `shutdownDefaultResolver()` to close the store at the end of a run. The static source is never stored. common: add `GRID_INTENSITY_STORE` and `GRID_INTENSITY_STORE_PATH` to the `GRID_INTENSITY` configuration block.
