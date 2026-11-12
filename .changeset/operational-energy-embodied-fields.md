---
'@cloud-carbon-footprint/core': minor
'@cloud-carbon-footprint/common': minor
'@cloud-carbon-footprint/aws': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
'@cloud-carbon-footprint/ali': minor
'@cloud-carbon-footprint/api': patch
---

Estimates from billing data carry their operational energy and their embodied emissions as two optional fields (ADR 0024). core: `FootprintEstimate` and `MutableServiceEstimate` gain `operationalKilowattHours` (the electricity the usage is modelled to consume) and `embodiedCo2e` (metric tons CO2e from hardware manufacturing); add `asOperationalEstimate` and `operationalKilowattHoursOf`; `accumulateKilowattHours` takes the operational energy as an optional last argument and `KilowattHourTotals` records it once it differs from the total; `UnknownEstimator` returns both fields; `appendOrAccumulateEstimatesByDay` sums them. common: `ServiceData` gains the two fields. aws, gcp, azure, ali: rows estimated from billing data set them. For a row with both fields and a grid intensity `g` in gCO2e/kWh, `co2e = operationalKilowattHours x g / 1e6 + embodiedCo2e`. On a row merged from parts with different provenance, `provenance.gCO2ePerKWh` is now the mean of the parts' intensities weighted by their electricity, so the identity holds there too. `kilowattHours` and `co2e` keep their values: `kilowattHours` is still operational energy plus embodied emissions expressed as energy at the row's grid factor. aws: a compute row with a memory estimate and no embodied figure keeps its memory energy at a grid intensity of exactly 0, where it lost it before; no static factor is 0, so the default configuration is not affected. api: the response schema documents the two fields and what `kilowattHours` is. Rows from the cloud usage APIs, on-premise output, a row with no `co2e` value and rows already in an estimates cache do not have the fields; a cached period keeps its rows until the cache is deleted. The two fields typically add 64 to 86 characters of JSON to a row, so the number of rows that fit in one line of a JSON cache file falls from about 1.1 million to about 950,000.
