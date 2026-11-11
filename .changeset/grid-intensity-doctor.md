---
'@cloud-carbon-footprint/cli': minor
'@cloud-carbon-footprint/api': minor
---

cli: add the `grid-intensity-doctor` command (`yarn workspace @cloud-carbon-footprint/cli grid-intensity-doctor`). For every AWS, GCP and Azure region it prints what each configured grid intensity source can deliver: its zone, the best quality tier for the last 24 hours, 30 days and 12 months, the licence state, any error and the attribution text. It needs no cloud credentials. api: add `GET /api/grid-intensity/capabilities`, which returns the same report as JSON. With the default configuration every region is tier D from the static factors.
