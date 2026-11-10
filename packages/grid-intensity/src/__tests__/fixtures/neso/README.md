# NESO Carbon Intensity API fixtures

Recorded exchanges with the public NESO Carbon Intensity API (`https://api.carbonintensity.org.uk`), for the contract tests of the NESO grid intensity source (design section 13). They were recorded on 2026-11-10 between 10:02Z and 11:14Z in the spike that closed verification backlog item 4. The findings are in `docs/design/spikes/2026-11-neso.md`.

No source uses these files yet. Phase 2 builds the source and its tests.

## Licence and attribution

The data in these files comes from the Carbon Intensity API, which is owned by National Energy System Operator (NESO) and licensed under CC BY 4.0. NESO publishes no attribution wording of its own (its terms of use, API documentation and website were checked on 2026-11-10). The text below follows what the licence asks for: the creator, a link to the source, the licence, and a statement of changes.

> Contains data from the Carbon Intensity API by National Energy System Operator (NESO), https://carbonintensity.org.uk, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

Changes made to the data: each response body is stored as parsed JSON inside an envelope that also records the request, and the files marked as trimmed keep only the periods they name. No value was altered.

The same attribution is repeated in the `attribution` property of every file, so a file copied on its own still carries it.

## File format

Each file is one exchange:

- `description`: what the exchange shows.
- `licence`, `attribution`: as above.
- `recordedAt`: when the request was sent (UTC).
- `trimmed`: `false`, or a note of what was kept.
- `request`: `method`, `url` and the `headers` that were sent. No authentication exists for this API.
- `response`: `status`, `headers` (the content type) and `body` as parsed JSON.

## Files

National intensity (`/intensity`):

- `national-range.json`: an aligned two hour range. Five periods come back, because the half hour ending at the requested start is included.
- `national-range-plus-one-minute.json`: the same start moved one minute later, with an unaligned end. Exactly the two half hours of one UTC hour.
- `national-range-missing-actual.json`: a range that runs past the present. A missing actual is `null`.
- `national-range-revised-actual.json`: the same request 32 minutes later. Two nulls are filled and one earlier actual has changed by 1.
- `national-range-revised-actual-later.json`: the same request 62 minutes after the first. A value published in between has changed by 1, and two forecasts have moved.
- `national-range-zero-actual.json`: an actual of 0 between 34 and 41, taken to be a data artefact. Trimmed.
- `national-range-first-periods.json`: the first periods the series has (2017-09-11T23:00Z). Trimmed.
- `national-range-empty.json`: an empty range, `{"data":[]}`.
- `national-range-before-first-period.json`: an empty range whose body is the JSON literal `null`.
- `national-date-settlement-period.json`: the date endpoints select by UK local day.
- `national-current.json`: the current half hour endpoint. Use it as a reachability probe only.
- `national-factors.json`: NESO's emission factors per fuel.

Generation mix (`/generation`):

- `generation-range.json`: one UTC hour; `data` is an array.
- `generation-current.json`: the current half hour; `data` is an object.

Regional intensity (`/regional`):

- `regional-range-regionid.json`: region 13 (London) over a past hour. Forecast only, no actual.
- `regional-range-postcode.json`: outward postcode CF10 over a past hour; resolves to region 7.
- `regional-range-all-regions.json`: all 18 regions for a past half hour. Trimmed to one period.
- `regional-current-regionid.json`: region 13 for the current half hour; `data` is an array here.
- `regional-range-first-periods.json`: the first periods the regional series has (2018-05-10T23:30Z). Trimmed.

Errors:

- `error-range-too-long.json`: 31 days, HTTP 400.
- `error-invalid-datetime.json`: HTTP 400.
- `error-start-after-end.json`: HTTP 400.
- `error-invalid-region-id.json`: HTTP 400.
- `error-postcode-not-found.json`: HTTP 400.
- `error-unknown-path.json`: HTTP 200 with an error object in the body.

## Using the fixtures

Tests never call the API. Mock `global.fetch` as `packages/common/src/__tests__/EmissionsFactors.test.ts` does and answer with `response.status` and `response.body` from a fixture. The `request.url` is the exact URL that produced the body, so a test can also assert the URL the source builds.

Do not re-record these casually. Recent actual values are revised by NESO after they first appear, so a new recording of the same request can differ.
