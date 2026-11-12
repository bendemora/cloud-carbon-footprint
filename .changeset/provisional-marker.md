---
'@cloud-carbon-footprint/common': minor
'@cloud-carbon-footprint/grid-intensity': minor
'@cloud-carbon-footprint/core': minor
'@cloud-carbon-footprint/api': patch
---

Estimates say when their grid intensity can still improve (the marker of ADR 0025). common: `Provenance` gains an optional `isProvisional`. It is `true` when the same configuration could give a better intensity for the row later: the source had not covered the whole usage period yet, its values were preliminary, or a source ranked ahead of it could not be reached. It is absent on a final row. The quality tier is not changed by it. grid-intensity: the resolver sets the marker; `IntensityPoint` gains an optional `isPreliminary`, with which a source marks a value it will replace, and such points are kept in memory for the capability TTL and never written to the configured store; `NoIntensityAvailableError` gains `mayImprove`, and the static fallback of `resolveEmissionsFactors` is marked provisional when it is set. core: `mergeProvenance` marks a merged row provisional when either part is. api: the response schema documents `isProvisional`. With the default configuration, where the only source is the static factors, no row is provisional. Nothing estimates a cached period again yet; the replace and refresh operations of ADR 0025 are not built.
