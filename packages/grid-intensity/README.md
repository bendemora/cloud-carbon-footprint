# @cloud-carbon-footprint/grid-intensity

Grid carbon intensity source layer for Cloud Carbon Footprint. It replaces the single static grid emissions factor per region with pluggable sources that report what they can deliver per zone (granularity, lookback, accounting basis, licence), a resolver that picks the best source for each usage period, and provenance on every estimate.

Design: `docs/design/2026-11-localised-time-resolved-carbon-estimation.md`, section 6. Decision record: `.adr/0022-grid_intensity_source_layer.md`.

## Status

Phase 1, first pull request. This package currently contains:

- The interfaces from section 6.1 of the design (`GridIntensitySource`, `IntensityStore`, `IntensityResolver`, `IntensityPoint`, `Provenance`, licence and capability types).
- `StaticSource`: the CCF static annual factors as a source. Always available, quality tier D. The factor tables stay in the provider packages and are given to the constructor, so this package depends on no other workspace package.
- `deriveQualityTier`: the tier rules from section 6.4.
- `requiresAcknowledgement`: which licences need an operator acknowledgement before a source is used (section 6.3).
- UTC period helpers and tCO2e/gCO2e conversions.

Not yet here: the Electricity Maps v4 source, the stores, the resolver, the `resolveEmissionsFactors` adapter and its wiring into the provider packages, the doctor command and the capabilities endpoint. Nothing in the estimation path uses this package yet.

## Units

Sources publish gCO2e/kWh; the CCF estimators use tCO2e/kWh. `tonnesToGrams` and `gramsToTonnes` round to 12 significant figures so that a static table value converted to grams and back is the identical number (the tables carry at most 10 significant figures).

## Static zones

`StaticSource` names zones `<provider>:<region>` with the provider in lower case, for example `aws:eu-west-2`. A region missing from a table maps to `<provider>:Unknown` when the table has an `Unknown` entry, which matches how `estimateCo2` in `packages/core` falls back today.

The basis and factor type of each table default to `location-production` and `direct`. That default is an inference from the sources the CCF methodology cites (EPA eGRID, EEA and carbonfootprint.com are generation-based); the provider wiring will declare each table explicitly, and the GCP tables need checking against Google's published method before they are labelled.
