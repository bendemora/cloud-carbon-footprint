# 22. Grid intensity source layer with capability negotiation and provenance

Date: 2026-11-05

## Status

Accepted

## Decision

Replace the per-row static grid emissions factor lookup with a source layer (`@cloud-carbon-footprint/grid-intensity`) in which each configured source declares, per zone, what granularity, lookback, accounting basis and licence it can deliver; a resolver picks the best available source for each usage period; and every service estimate carries provenance (source, zone, granularity, basis, factor type, estimation flag, licence, quality tier, model version, calibration version).

Sources with contractual terms are plug-ins enabled by the operator's credentials, files and an explicit licence acknowledgement. The tool bundles no licensed data, enforces no vendor terms, applies the retention each source declares, and writes a licence manifest with every export.

Full design: `docs/design/2026-11-localised-time-resolved-carbon-estimation.md`.

## Context

- The co2e step is `kWh * emissionsFactors[region]` with a flat `{ region: tCO2e/kWh }` map; there is no time or zone dimension.
- The existing Electricity Maps integration calls the v3 `past` endpoint with the start of the usage period, so it applies one hour's intensity (midnight of the first day) to a whole day or month, and it persists nothing.
- The project's goal is localised, time-resolved, clearly labelled estimates that can be exported next to cost, for an open-source audience first and for commercial deployments that bring their own data entitlements.
- Open, commercial-use grid data exists for Great Britain (NESO, CC BY 4.0), the EU (ENTSO-E) and the United States (EIA, public domain); Electricity Maps and WattTime are commercial.

## Consequences

- Provider packages call one resolver function instead of reading static maps; the static maps remain as the always-available fallback (quality tier D).
- `ServiceData` gains optional provenance fields; the cache, API and client remain compatible.
- A new persistent store for intensity points (LOCAL and MONGODB backends, no native dependencies).
- Adding a data source means implementing one interface, adding recorded fixtures and registry entries, and declaring a licence.
- Operators must acknowledge commercial or non-commercial sources in configuration before they are used; this is recorded, not verified.
