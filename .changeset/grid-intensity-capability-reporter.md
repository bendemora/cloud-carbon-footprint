---
'@cloud-carbon-footprint/grid-intensity': minor
---

grid-intensity: add `GridIntensityCapabilityReporter`, the report behind the doctor command and the capabilities endpoint (design section 6.5). For each provider region and each source of a resolver it gives the source's zone, the licence state (`open`, `acknowledged`, `needs-acknowledgement`, `unavailable`), the best quality tier the source can deliver for a day of usage in the last 24 hours, 30 days and 12 months, the share of each window's days it can serve, the attribution text and any error. `GridIntensityResolver.sourceViews` gives what the resolver knows about each source for a region: the capability answer it holds, the reason a zone's fetches are stopped, and the source's probe answer, which it now keeps for the capability TTL. `SourceCapabilitySummary` gains `coverage` and `attribution`. Estimates are unchanged.
