# 24. Operational energy and embodied emissions as separate fields

Date: 2026-11-10

## Status

Accepted with the merge of pull request #31, which implements it. Design section 12 puts these fields before the first live source. The implementation notes at the end record what was built and where it departs from the text below.

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

- `core`, `common`, `aws`, `gcp`, `azure` and `ali` change. The new fields are optional, so the API, the client, the CLI and cache files stay compatible. On-premise output does not gain the fields (see the implementation notes; this sentence first said it would report `operationalKilowattHours` equal to `kilowattHours` and `embodiedCo2e` of 0).
- Output in the default configuration does not change, apart from the two new fields. Provider tests that compare with upstream values stay as they are, and new tests assert the identity in point 4 for every row.
- Rows that accumulate (same period, region, service, account and tags) sum the two fields as they sum the totals. A merged row has the fields only if every part has them.
- Rows cached before the change have neither field. The export leaves their energy and embodied columns empty until the period is estimated again from billing data (ADR 0025).
- The API documentation says what `kilowattHours` is: a legacy total, and not an energy measure (see the implementation notes). `Provenance.gCO2ePerKWh` keeps its meaning.
- Two known faults stay until the model version decides them: the embodied share that AWS and Azure unknown-usage rows inherit (GCP rows do not), and the embodied energy inside `kilowattHours`. Until then the legacy energy of rows resolved from a live source is not comparable between periods.
- Each row grows by two numbers, typically 64 to 86 characters of JSON, so fewer rows fit within the cache and response size limits described in `microsite/docs/ConfigurationOptions/DataPersistenceAndCaching.md`: about 950,000 in one line of a JSON cache file, where about 1.1 million fitted.

## Implementation notes (2026-11-12)

- **Where the fields are set.** Rows estimated from billing data on AWS, Google Cloud, Azure and Alibaba Cloud carry both fields. On AWS and Azure a compute row with a memory or an embodied part sets them from its parts: `operationalKilowattHours` is the compute and memory energy, `embodiedCo2e` is the result of `EmbodiedEmissionsEstimator`. On Google Cloud a compute row with an embodied part does the same with its compute energy; memory is a row of its own there. Every other row of those three providers, except unknown usage (below), is marked by `asOperationalEstimate` in `packages/core`, which sets `operationalKilowattHours` to `kilowattHours` and `embodiedCo2e` to 0. Alibaba Cloud builds one row from all its parts and sets the fields there.
- **Rows that do not get them.** A row with no finite `co2e` (point 4) has neither field: an AWS instance type that cannot be sized, unknown usage whose average is not a finite number, an Alibaba Cloud row with no service period. Rows from the cloud usage APIs (billing data turned off) are left alone too. They are built in `packages/core` (`CloudProviderAccount.getRegionData`) by services that do not use the embodied estimator, and they carry no provenance either. The design needs both on those rows before the export in Phase 7 (section 14, deferred work); this change adds neither.
- **On-premise.** The consequences first said that on-premise rows report the two fields. They do not. On-premise output is a table with one energy column and one emissions column per period (`OnPremiseDataOutput` in `packages/common`), not a list of service estimates. Its energy columns are operational energy already, because on-premise estimates have no embodied model. Reporting the fields would add eight columns that repeat four existing ones and four zeros, in a file format other tools may parse. The design's export lists `On-Premise` as a provider (section 11.1). When it is built it can take its energy from these columns as they are and write embodied emissions of 0.
- **Unknown usage (point 5).** `KilowattHourTotals` records its operational sum only once it differs from `kilowattHours`, so the running totals of usage with no embodied emissions keep the shape they had. `operationalKilowattHoursOf` reads a total either way. `UnknownEstimator` returns `operationalKilowattHours` from the operational average and `embodiedCo2e` as the rest of the row's `co2e`. On Google Cloud the running average never held embodied energy, so its unknown-usage rows have `embodiedCo2e` of 0. On AWS and Azure the `embodiedCo2e` of an unknown-usage row is the share it inherits from the embodied emissions of the known rows, priced at its own grid factor, so it moves with the grid factors. In a run on 2026-11-12 the same AWS usage had 1.284e-5 t when the known row and the unknown row were both resolved at 400 gCO2e/kWh, 1.027e-4 t with the known row at 50 and the unknown row at 400, and 1.61e-6 t the other way round. This is the fault that point 6 leaves to the model version; the fields make it visible and do not correct it.
- **Rows that accumulate.** `appendOrAccumulateEstimatesByDay` sums the two fields with the totals, and removes them from the merged row when any part lacks them.
- **Merged rows whose parts differ in provenance.** When both parts carry the fields, `appendOrAccumulateEstimatesByDay` gives `mergeProvenance` the electricity of each part as its weight. The blended `gCO2ePerKWh` is then the intensity of the merged row's electricity, and the identity in point 4 holds on it. The change first weighted by the legacy `kilowattHours`, as before; a review found the identity 10 % to 59 % out on such rows in three cases, so the weight was changed. On such a row the older relation `co2e = kilowattHours x gCO2ePerKWh / 1e6` does not hold; it holds on every row that is not merged from parts with different provenance. Parts that do not both carry the fields are weighted by the legacy total. Rows of one region and usage period normally carry identical provenance, and then nothing is blended.
- **At an intensity of exactly 0.** The identity holds. An AWS compute row with a memory estimate and no embodied figure used to lose its memory energy there, in the legacy total and so in the new field, because an upstream line tested the memory emissions, which are 0 on a grid at 0. The line now tests the memory energy, as the Azure code does. Nothing changes at any other intensity, and no static factor is 0, so the default configuration is not affected.
- **What `kilowattHours` is.** The consequences first said it "stops being an energy measure once intensity varies". It is not one with the static factors either: there the embodied part is a fixed addition for a region. In a run on 2026-11-12 with the static factors the `kilowattHours` of an EC2 `m5.xlarge` row was 6.0 % above its operational energy in `us-east-1`, 7.1 % in `eu-west-2` and 271.6 % in `eu-north-1`, whose factor is 8 gCO2e/kWh.
- **Tests.** The AWS, Google Cloud and Azure billing tests assert the identity in point 4 on every row that has the fields. Each has a case that resolves the same usage at 400 and at 50 gCO2e/kWh and expects the same operational energy and embodied emissions from both; every row of a case is resolved at one intensity, which is why the unknown-usage rows agree. Further cases cover a row with no `co2e` value on AWS and Alibaba Cloud, an Azure unknown-usage row that inherits embodied emissions, the AWS row at an intensity of 0, and merged rows with different provenance in `packages/core`. The values the existing tests compare with upstream's did not change.
- **Not verified.** A run on real billing data.
