# 24. Operational energy and embodied emissions as separate fields

Date: 2026-11-10

## Status

Proposed

## Decision

Every estimate carries its operational energy and its embodied emissions as two separate values, next to the two totals it carries today.

1. `FootprintEstimate` and `ServiceData` gain two optional fields: `operationalKilowattHours`, the electricity the usage is modelled to consume (PUE and replication included), and `embodiedCo2e`, the metric tons of CO2e from hardware manufacturing attributed to the usage. Operational emissions are `co2e - embodiedCo2e`.
2. `kilowattHours` and `co2e` keep upstream's definitions and values. `kilowattHours` still includes embodied emissions expressed as energy at the grid factor applied to the row. They are legacy totals, kept so that the client, the CLI tables and existing cache files keep working, and so that output in the default configuration does not change.
3. Everything this programme adds reads the new fields and never the legacy `kilowattHours`: the export columns `EnergyKWh`, `OperationalLocationKgCO2e` and `EmbodiedKgCO2e` (design section 11.1), the factor table (section 9), the time-of-day report (section 7) and calibration (section 10).
4. For a row with both fields and a resolved intensity `g` in gCO2e/kWh, `co2e = operationalKilowattHours x g / 1e6 + embodiedCo2e`. This holds at any intensity, including 0. Rows without a `co2e` value (an AWS instance type CCF cannot size, an upstream limit) are unchanged.
5. Unknown-usage rows (usage types estimated from the average of known ones) take `operationalKilowattHours` from an average of operational energy only, and `embodiedCo2e` is the rest of their `co2e`. Their legacy totals do not change. The running average (`KilowattHourTotals`) gains an operational sum next to `kilowattHours` for this.
6. Two questions are model changes and are decided with the energy model version (`MODEL_VERSION`, design section 9), not here: whether `kilowattHours` becomes operational energy only, and how unknown-usage rows should inherit embodied emissions.

## Context

Verified in the code on 2026-11-10 (trunk `a42b5ac6`):

- `EmbodiedEmissionsEstimator` (`packages/core/src/embodiedEmissions/EmbodiedEmissionsEstimator.ts`) computes embodied emissions in metric tons from the instance's manufacturing figure, the usage time over the server lifespan and the share of vCPUs. Grid intensity plays no part in that. It then turns the result into energy with `estimateKwh` (`packages/core/src/FootprintEstimate.ts`): the metric tons divided by the grid factor.
- AWS, GCP, Azure and Alibaba Cloud add that energy to the row's `kilowattHours` and the emissions to its `co2e` (`CostAndUsageReports.ts`, `BillingExportTable.ts`, `ConsumptionManagement.ts`, `AliCostAndUsageService.ts`). A stored row therefore holds two totals related by `co2e = kilowattHours x factor`. Its operational energy and its embodied emissions cannot be worked back out of them: that is one equation with two unknowns.
- AWS and Azure add the row total, embodied energy included, to the running average that unknown-usage rows are estimated from (`KILOWATT_HOURS_BY_SERVICE_AND_USAGE_UNIT`). GCP adds compute energy only. So on AWS and Azure an unknown-usage row inherits embodied emissions as if they were energy, priced at its own grid factor.
- The methodology page gives total CO2e as operational plus embodied emissions. Its embodied section and `EmbodiedEmissions.md` do not mention turning embodied emissions into energy.
- On-premise estimates have no embodied model.

Why this needs deciding now:

- With a static factor the embodied energy is a constant overstatement of `kilowattHours`. With a live intensity it moves the wrong way: the same embodied emissions become more kWh when the grid is cleaner. Design section 6.1 records the scale (0.002 t at 0.5 gCO2e/kWh is 4,000 kWh) and the stopgap at exactly 0.
- That starts with the first live source in Phase 2, not in phases 6 and 7 where the design first asks for the split. The same usage shows more energy on a day resolved at 80 gCO2e/kWh than on a day at 300.
- The time-of-day report in Phase 3 ranks hours by energy. Read from `kilowattHours`, it would overstate the energy used in the cleanest hours, which is the opposite of what the report is for.
- The export, the factor table and calibration each need operational energy and embodied emissions as separate numbers.
- With the two values stored, a row's emissions can be worked out again at a better intensity without reading the billing data (ADR 0025).

Alternatives considered:

- Redefine `kilowattHours` as operational energy now. It is the cleanest result, but it changes the energy of every compute row in the default configuration. That breaks the rule that tier D output stays identical to upstream's (design section 6.1) and principle 7 (additive changes only). It belongs with a model version, where the change is announced.
- Convert embodied emissions at the static annual factor even when a live intensity is applied. The legacy energy would stop moving with the grid, but it would still not be an energy, and `co2e = kilowattHours x gCO2ePerKWh / 1e6`, which the API schema documents, would stop holding.
- Leave rows as they are and compute the split in the exporter. Not possible: the stored row has lost the information.

## Consequences

- `core`, `common`, `aws`, `gcp`, `azure` and `ali` change. The new fields are optional, so the API, the client, the CLI and cache files stay compatible. On-premise rows report `operationalKilowattHours` equal to `kilowattHours` and `embodiedCo2e` of 0.
- Output in the default configuration does not change. Provider tests that compare with upstream values stay as they are, and new tests assert the identity in point 4 for every row.
- Rows that accumulate (same period, region, service, account and tags) sum the two fields as they sum the totals. A merged row has the fields only if every part has them.
- Rows cached before the change have neither field. The export leaves their energy and embodied columns empty until the period is estimated again from billing data (ADR 0025).
- The API documentation says what `kilowattHours` is: a legacy total that stops being an energy measure once intensity varies. `Provenance.gCO2ePerKWh` keeps its meaning.
- Two known faults stay until the model version decides them: the embodied share that AWS and Azure unknown-usage rows inherit (GCP rows do not), and the embodied energy inside `kilowattHours`. Until then the legacy energy of rows resolved from a live source is not comparable between periods.
- Each row grows by two numbers, about 60 characters of JSON, so slightly fewer rows fit within the cache and response size limits described in `microsite/docs/ConfigurationOptions/DataPersistenceAndCaching.md`.
