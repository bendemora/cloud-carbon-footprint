# @cloud-carbon-footprint/grid-intensity

Grid carbon intensity source layer for Cloud Carbon Footprint. It replaces the single static grid emissions factor per region with pluggable sources that report what they can deliver per zone (granularity, lookback, accounting basis, licence), a resolver that picks the best source for each usage period, and provenance on every estimate.

Design: `docs/design/2026-11-localised-time-resolved-carbon-estimation.md`, section 6. Decision record: `.adr/0022-grid_intensity_source_layer.md`.

## Status

Phase 1. This package contains:

- The interfaces from section 6.1 of the design (`GridIntensitySource`, `IntensityStore`, `IntensityResolver`, `IntensityPoint`, `Provenance`, licence and capability types).
- `StaticSource`: the CCF static annual factors as a source. Always available, quality tier D. The factor tables stay in the provider packages and are given to the constructor, so this package depends on no provider package.
- `GridIntensityResolver`: the resolution policy from section 6.2. Sources are tried in configured order; those that cannot deliver data at least as fine as the usage period are tried only after the others, finest first. Commercial, non-commercial and custom licences need an operator acknowledgement. Stored points are read first and only missing periods are fetched. Failures are logged once per source and zone, negative-cached for the capability TTL, and never abort a run.
- Stores (section 6.6): `LocalIntensityStore` (one JSON file per source, zone, granularity and month under `GRID_INTENSITY_STORE_PATH`), `MongoDbIntensityStore` (collection `grid-intensity-points` in the `ccf` database, using `MONGODB_URI`), and `InMemoryIntensityStore`. The static source is never stored. Store files may hold licensed data: `.ccf/` is in `.gitignore`.
- `resolveEmissionsFactors`: the adapter the provider packages will call in place of `getEmissionsFactors`. It builds a default resolver and store from the configuration below. When the static source is used, it returns the caller's table unchanged, so estimates stay identical to today's. `shutdownDefaultResolver()` closes the store at the end of a run.
- `deriveQualityTier` (section 6.4), `requiresAcknowledgement` (section 6.3), UTC period helpers, time-weighting and tCO2e/gCO2e conversions.

Not yet here: the Electricity Maps v4 source, provenance on `ServiceData` and the wiring into the provider packages, the doctor command and the capabilities endpoint. Nothing in the estimation path uses this package yet.

## Configuration

| Key                                       | Default  | Meaning                                                                                                                             |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GRID_INTENSITY_SOURCES`                  | `static` | Comma-separated source ids in priority order. Only `static` exists so far; unknown ids are ignored with a warning.                  |
| `GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS` | empty    | Source ids the operator asserts they are licensed to use. Required for sources with a commercial, non-commercial or custom licence. |
| `GRID_INTENSITY_CAPABILITY_TTL_HOURS`     | `24`     | How long capability answers and failures are cached.                                                                                |

## Units

Sources publish gCO2e/kWh; the CCF estimators use tCO2e/kWh. `tonnesToGrams` and `gramsToTonnes` round to 12 significant figures so that a static table value converted to grams and back is the identical number (the tables carry at most 10 significant figures).

## Static zones

`StaticSource` names zones `<provider>:<region>` with the provider in lower case, for example `aws:eu-west-2`. A region missing from a table maps to `<provider>:Unknown` when the table has an `Unknown` entry, which matches how `estimateCo2` in `packages/core` falls back today.

The basis and factor type of each table default to `location-production` and `direct`. That default is an inference from the sources the CCF methodology cites (EPA eGRID, EEA and carbonfootprint.com are generation-based); the provider wiring will declare each table explicitly, and the GCP tables need checking against Google's published method before they are labelled.
