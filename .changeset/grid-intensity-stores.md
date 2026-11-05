---
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/common': minor
---

grid-intensity: add the LOCAL (JSON files) and MONGODB intensity stores, selected by `GRID_INTENSITY_STORE` for the default resolver, and `shutdownDefaultResolver()` to close the store at the end of a run. The static source is never stored. Overlapping writes to one LOCAL file within a process are serialised and keep every point; ids that differ only in case are never mixed on case-insensitive file systems; `purge` skips files the store did not write and removes stale temporary files. The MONGODB store tries to connect again five minutes after a failed connection. common: add `GRID_INTENSITY_STORE` and `GRID_INTENSITY_STORE_PATH` to the `GRID_INTENSITY` configuration block.
