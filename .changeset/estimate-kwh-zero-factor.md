---
'@cloud-carbon-footprint/core': patch
---

core: `estimateKwh` returns 0 kWh instead of Infinity or NaN when neither the region nor `Unknown` has a non-zero factor, so embodied emissions in a zone at 0 gCO2e/kWh no longer turn the row's kWh into Infinity. Results for any non-zero factor are unchanged.
