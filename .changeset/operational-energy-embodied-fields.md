---
'@cloud-carbon-footprint/core': minor
'@cloud-carbon-footprint/common': minor
'@cloud-carbon-footprint/aws': minor
'@cloud-carbon-footprint/gcp': minor
'@cloud-carbon-footprint/azure': minor
'@cloud-carbon-footprint/ali': minor
'@cloud-carbon-footprint/api': patch
---

Estimates from billing data carry their operational energy and their embodied emissions as two optional fields (ADR 0024). core: `FootprintEstimate` and `MutableServiceEstimate` gain `operationalKilowattHours` (the electricity the usage is modelled to consume) and `embodiedCo2e` (metric tons CO2e from hardware manufacturing); add `asOperationalEstimate` and `operationalKilowattHoursOf`; `accumulateKilowattHours` takes the operational energy as an optional last argument and `KilowattHourTotals` records it once it differs from the total; `UnknownEstimator` returns both fields; `appendOrAccumulateEstimatesByDay` sums them. common: `ServiceData` gains the two fields. aws, gcp, azure, ali: rows estimated from billing data set them. For a row with both fields and a grid intensity `g` in gCO2e/kWh, `co2e = operationalKilowattHours x g / 1e6 + embodiedCo2e`. `kilowattHours` and `co2e` keep their values: `kilowattHours` is still operational energy plus embodied emissions expressed as energy at the row's grid factor. api: the response schema documents the two fields and what `kilowattHours` is. Rows from the cloud usage APIs, rows already in an estimates cache and on-premise output do not have the fields.
