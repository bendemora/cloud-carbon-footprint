---
'@cloud-carbon-footprint/grid-intensity': patch
---

The resolver no longer asks a source again, within the capability TTL, for a period the source had no usable point for. Nothing is stored for such a period and the resolver is called once per billing row, so one gap in a source's data used to cost a request for every row of that region and period. The static source is not affected: it has a value for every period.
