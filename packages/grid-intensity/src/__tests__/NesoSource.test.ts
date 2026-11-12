/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  NESO_HOLD_BACK_HOURS,
  NESO_MAX_RANGE_DAYS,
  NESO_TIMEOUT_MS,
  NESO_USER_AGENT,
  NESO_ZONES,
  NesoSource,
} from '../sources/NesoSource'
import { CloudProvider, IntensityPoint } from '../types'
import {
  generatedRange,
  jsonResponse,
  mockNesoApi,
  NESO_API,
  NesoApiMock,
  nesoFixture,
  NesoPeriod,
} from './fixtures/nesoApi'

/*
 * Contract tests of the NESO source (design section 13). No test calls the
 * network: `fetch` is answered from the exchanges recorded in
 * fixtures/neso, or from bodies written in the recorded shape where a test
 * says so. The source is specified in docs/design/spikes/2026-11-neso.md.
 */

const utc = (iso: string) => new Date(iso)
const RETRIEVED_AT = utc('2026-11-12T09:00:00.000Z')

/** The request of fixtures/neso/national-range.json, two whole UTC hours. */
const START = utc('2026-11-03T00:00:00.000Z')
const END = utc('2026-11-03T02:00:00.000Z')
const RANGE_PATH = '/intensity/2026-11-03T00:00Z/2026-11-03T02:00Z'
const RANGE_URL = `${NESO_API}${RANGE_PATH}`

const hourly = (
  periodStart: string,
  gCO2ePerKWh: number,
  retrievedAt = RETRIEVED_AT,
): IntensityPoint => ({
  zoneId: 'national',
  periodStart: utc(periodStart),
  periodEnd: new Date(utc(periodStart).getTime() + 3600 * 1000),
  granularity: 'hour',
  gCO2ePerKWh,
  basis: 'location-consumption',
  factorType: 'direct',
  isEstimated: false,
  sourceId: 'neso',
  retrievedAt,
})

/**
 * A period in the recorded shape, for bodies a test writes itself. An
 * `actual` of undefined leaves the property out of the JSON.
 */
const period = (
  from: string,
  to: string,
  actual: unknown,
): Record<string, unknown> => ({
  from,
  to,
  intensity: { forecast: 999, actual, index: 'moderate' },
})

const failed = (reason: string, path = RANGE_PATH): string =>
  `NESO Carbon Intensity API: GET ${path} failed: ${reason}`

describe('NesoSource', () => {
  let api: NesoApiMock
  let source: NesoSource

  beforeEach(() => {
    api = mockNesoApi()
    // No waiting between requests here: the spacing has tests of its own
    // in NesoSource.pacing.test.ts.
    source = new NesoSource({
      fetch: api.fetch,
      now: () => RETRIEVED_AT,
      minRequestIntervalMs: 0,
    })
  })

  afterEach(() => {
    api.assertNoUnknownRequests()
  })

  const fetchRange = () => source.fetch('national', START, END, 'hour')

  it('has the id neso and a CC BY 4.0 licence that needs no acknowledgement', () => {
    expect(source.id).toBe('neso')
    expect(source.licence).toEqual({
      id: 'CC-BY-4.0',
      attribution:
        'Contains data from the Carbon Intensity API by National Energy System Operator (NESO), https://carbonintensity.org.uk, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Half-hourly values averaged to hours.',
      redistributable: true,
      retention: 'unlimited',
      termsUrl: 'https://github.com/carbon-intensity/terms',
    })
  })

  it('attributes the data as the fixtures do, and adds the note of changes', () => {
    expect(source.licence.attribution).toBe(
      `${nesoFixture('national-range').attribution} Half-hourly values averaged to hours.`,
    )
  })

  describe('the request', () => {
    it('asks for an aligned range with the recorded URL, method and Accept header', async () => {
      const fixture = nesoFixture('national-range')
      api.serve(fixture)

      await fetchRange()

      expect(api.fetch).toHaveBeenCalledTimes(1)
      const [url, init] = api.fetch.mock.calls[0]
      expect(url).toBe(
        'https://api.carbonintensity.org.uk/intensity/2026-11-03T00:00Z/2026-11-03T02:00Z',
      )
      expect(url).toBe(fixture.request.url)
      expect(init).toEqual({
        method: fixture.request.method,
        headers: {
          Accept: fixture.request.headers.Accept,
          'User-Agent': NESO_USER_AGENT,
        },
        signal: expect.any(AbortSignal),
      })
      expect(init?.method).toBe('GET')
      expect(fixture.request.headers.Accept).toBe('application/json')
    })

    it('names the application and its version in the User-Agent, and nothing else', () => {
      const { version } = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
      )
      expect(NESO_USER_AGENT).toBe(
        `cloud-carbon-footprint-grid-intensity/${version}`,
      )
      expect(NESO_USER_AGENT).toMatch(
        /^cloud-carbon-footprint-grid-intensity\/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
      )
    })

    it('arms a timeout of 30 seconds on each request', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout')
      try {
        api.serve(nesoFixture('national-range'))
        await fetchRange()
        expect(NESO_TIMEOUT_MS).toBe(30_000)
        expect(timeout).toHaveBeenCalledTimes(1)
        expect(timeout).toHaveBeenCalledWith(NESO_TIMEOUT_MS)
        expect(api.inits()[0]?.signal).toBe(timeout.mock.results[0].value)
      } finally {
        timeout.mockRestore()
      }
    })

    it('uses the base URL it is given', async () => {
      const elsewhere = new NesoSource({
        baseUrl: 'http://neso.test:8080/proxy',
        fetch: api.fetch,
        now: () => RETRIEVED_AT,
      })
      api.serveAs(
        `http://neso.test:8080/proxy${RANGE_PATH}`,
        nesoFixture('national-range'),
      )
      await expect(
        elsewhere.fetch('national', START, END, 'hour'),
      ).resolves.toHaveLength(2)
    })

    describe('with no fetch given', () => {
      const realFetch = global.fetch

      afterEach(() => {
        global.fetch = realFetch
      })

      it('calls global.fetch, looked up when the request is made', async () => {
        const fixture = nesoFixture('national-range')
        api.serve(fixture)
        // Built before the stand-in is in place, as the default resolver's
        // source is built before a test replaces global.fetch.
        const byDefault = new NesoSource({ now: () => RETRIEVED_AT })
        global.fetch = api.fetch

        const points = await byDefault.fetch('national', START, END, 'hour')

        expect(api.urls()).toEqual([fixture.request.url])
        expect(points).toHaveLength(2)
      })
    })

    it('asks for nothing when the range is empty', async () => {
      await expect(
        source.fetch('national', START, START, 'hour'),
      ).resolves.toEqual([])
      await expect(
        source.fetch('national', END, START, 'hour'),
      ).resolves.toEqual([])
      expect(api.fetch).not.toHaveBeenCalled()
    })

    it.each(['day', 'month', 'year'] as const)(
      'rejects %s granularity without a request',
      async (granularity) => {
        await expect(
          source.fetch('national', START, END, granularity),
        ).rejects.toThrow(
          `NESO source only provides hour granularity, not ${granularity}`,
        )
        expect(api.fetch).not.toHaveBeenCalled()
      },
    )

    it.each(['region-13', 'GB', ''])(
      'rejects the zone "%s" without a request',
      async (zoneId) => {
        await expect(source.fetch(zoneId, START, END, 'hour')).rejects.toThrow(
          `NESO source has no zone ${zoneId}, only national`,
        )
        expect(api.fetch).not.toHaveBeenCalled()
      },
    )
  })

  describe('hours from half hours', () => {
    it('drops the extra leading half hour and gives each hour the mean of its two halves', async () => {
      // Five periods come back. The first, 23:30 with an actual of 129, ends
      // at the requested start. The others read 128, 121, 121 and 120.
      api.serve(nesoFixture('national-range'))

      await expect(fetchRange()).resolves.toEqual([
        hourly('2026-11-03T00:00:00.000Z', 124.5),
        hourly('2026-11-03T01:00:00.000Z', 120.5),
      ])
    })

    it('gives no point for an hour that lies only partly inside the range', async () => {
      // Recorded with the start one minute after the hour: the two half
      // hours of 00:00 to 01:00 come back, and the first starts before the
      // range does.
      const fixture = nesoFixture('national-range-plus-one-minute')
      api.serve(fixture)

      await expect(
        source.fetch(
          'national',
          utc('2026-11-03T00:01:00.000Z'),
          utc('2026-11-03T01:15:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([])
      expect(api.urls()).toEqual([fixture.request.url])
    })

    it('uses no period that lies outside the range, at either end', async () => {
      // Written in the recorded shape. The first period ends where the
      // range starts, as the API's extra one does. The last ends after the
      // range does, which the API has not been seen to send.
      api.respondTo(
        `${NESO_API}/intensity/2026-11-03T00:30Z/2026-11-03T01:30Z`,
        () =>
          jsonResponse({
            data: [
              period('2026-11-03T00:00Z', '2026-11-03T00:30Z', 128),
              period('2026-11-03T00:30Z', '2026-11-03T01:00Z', 121),
              period('2026-11-03T01:00Z', '2026-11-03T01:30Z', 121),
              period('2026-11-03T01:30Z', '2026-11-03T02:00Z', 120),
            ],
          }),
      )

      await expect(
        source.fetch(
          'national',
          utc('2026-11-03T00:30:00.000Z'),
          utc('2026-11-03T01:30:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([])
    })

    it('reads datetimes that carry seconds', async () => {
      // Not seen from the API, which writes minutes. Written in the recorded
      // shape with seconds added.
      api.respondTo(RANGE_URL, () =>
        jsonResponse({
          data: [
            period('2026-11-03T00:00:00Z', '2026-11-03T00:30:00Z', 128),
            period('2026-11-03T00:30:00.000Z', '2026-11-03T01:00:00.000Z', 121),
            // Half an hour long, but not on a half hour.
            period('2026-11-03T01:00:15Z', '2026-11-03T01:30:15Z', 121),
            period('2026-11-03T01:30Z', '2026-11-03T02:00Z', 120),
          ],
        }),
      )
      await expect(fetchRange()).resolves.toEqual([
        hourly('2026-11-03T00:00:00.000Z', 124.5),
      ])
    })

    it('stamps points with the current time when no clock is given', async () => {
      api.serve(nesoFixture('national-range'))
      const before = Date.now()
      const [point] = await new NesoSource({ fetch: api.fetch }).fetch(
        'national',
        START,
        END,
        'hour',
      )
      expect(point.retrievedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.retrievedAt.getTime()).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('missing and revised actual values', () => {
    // One request, recorded three times in 62 minutes. The half hours start
    // at 08:30 (before the requested start of 08:31), 09:00, 09:30, 10:00,
    // 10:30 and 11:00. The range ends at 11:30, so the hour from 11:00 is
    // never whole.
    const fetchMorning = (name: string, recordedAt: Date) => {
      const fixture = nesoFixture(name)
      expect(fixture.request.url).toBe(
        'https://api.carbonintensity.org.uk/intensity/2026-11-10T08:31Z/2026-11-10T11:30Z',
      )
      api.serve(fixture)
      return new NesoSource({
        fetch: api.fetch,
        now: () => recordedAt,
        minRequestIntervalMs: 0,
      }).fetch(
        'national',
        utc('2026-11-10T08:31:00.000Z'),
        utc('2026-11-10T11:30:00.000Z'),
        'hour',
      )
    }

    it('gives no point for an hour with a null half, and does not use the forecast', async () => {
      // 09:00 reads 249 and 09:30 is null with a forecast of 250; 10:00 and
      // 10:30 are null with forecasts of 242 and 238. Filling from the
      // forecast would give 249.5 and 240.
      const recordedAt = utc('2026-11-10T10:11:38.000Z')
      await expect(
        fetchMorning('national-range-missing-actual', recordedAt),
      ).resolves.toEqual([])
      expect(api.urls()).toHaveLength(1)
    })

    it('gives the hour once both halves are published, 32 minutes later', async () => {
      // 09:00 now reads 248 (revised from 249) and 09:30 reads 246. 10:00
      // reads 243 and 10:30 is still null.
      const recordedAt = utc('2026-11-10T10:43:30.000Z')
      await expect(
        fetchMorning('national-range-revised-actual', recordedAt),
      ).resolves.toEqual([hourly('2026-11-10T09:00:00.000Z', 247, recordedAt)])
    })

    it('gives the revised value, 62 minutes after the first request', async () => {
      // 10:00 now reads 244 (revised from 243) and 10:30 reads 242.
      const recordedAt = utc('2026-11-10T11:13:30.000Z')
      await expect(
        fetchMorning('national-range-revised-actual-later', recordedAt),
      ).resolves.toEqual([
        hourly('2026-11-10T09:00:00.000Z', 247, recordedAt),
        hourly('2026-11-10T10:00:00.000Z', 243, recordedAt),
      ])
    })

    it('would not have been offered any of these hours when they were recorded', async () => {
      // The values of 09:00 and 10:00 changed between the recordings. With
      // the hold-back the first hour of the request, 09:00 to 10:00, is
      // offered from 12:00.
      for (const recordedAt of [
        '2026-11-10T10:11:38.000Z',
        '2026-11-10T10:43:30.000Z',
        '2026-11-10T11:13:30.000Z',
        '2026-11-10T11:59:59.999Z',
      ]) {
        const capability = await new NesoSource({
          now: () => utc(recordedAt),
        }).capabilities('national')
        expect(capability?.latest?.getTime()).toBeLessThanOrEqual(
          utc('2026-11-10T09:00:00.000Z').getTime(),
        )
      }
      const atNoon = await new NesoSource({
        now: () => utc('2026-11-10T12:00:00.000Z'),
      }).capabilities('national')
      expect(atNoon?.latest).toEqual(utc('2026-11-10T10:00:00.000Z'))
    })

    it('treats an actual of 0 as missing', async () => {
      // The fixture is five half hours cut from a range of almost 31 days,
      // which the source never asks for in one request. It is served here
      // for the two hours that hold the artefact: 10:00 reads 61 and 34,
      // 11:00 reads 0 and 41.
      api.serveAs(
        `${NESO_API}/intensity/2026-08-06T10:00Z/2026-08-06T12:00Z`,
        nesoFixture('national-range-zero-actual'),
      )

      await expect(
        source.fetch(
          'national',
          utc('2026-08-06T10:00:00.000Z'),
          utc('2026-08-06T12:00:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([hourly('2026-08-06T10:00:00.000Z', 47.5)])
    })

    it.each([
      ['null', null],
      ['a negative number', -5],
      ['a number in a string', '128'],
      ['no actual property', undefined],
    ])('treats %s as a missing actual', async (_case, actual) => {
      // Written in the recorded shape.
      api.respondTo(RANGE_URL, () =>
        jsonResponse({
          data: [
            period('2026-11-03T00:00Z', '2026-11-03T00:30Z', 128),
            period('2026-11-03T00:30Z', '2026-11-03T01:00Z', actual),
            period('2026-11-03T01:00Z', '2026-11-03T01:30Z', 121),
            period('2026-11-03T01:30Z', '2026-11-03T02:00Z', 120),
          ],
        }),
      )
      await expect(fetchRange()).resolves.toEqual([
        hourly('2026-11-03T01:00:00.000Z', 120.5),
      ])
    })

    it('treats an actual that is not a finite number as missing', async () => {
      // JSON has no literal for infinity, but a number too large for a
      // double parses to it. Written in the recorded shape.
      api.respondTo(
        RANGE_URL,
        () =>
          new Response(
            `{"data":[
              {"from":"2026-11-03T00:00Z","to":"2026-11-03T00:30Z","intensity":{"forecast":133,"actual":128,"index":"moderate"}},
              {"from":"2026-11-03T00:30Z","to":"2026-11-03T01:00Z","intensity":{"forecast":125,"actual":1e999,"index":"moderate"}}
            ]}`,
            { status: 200 },
          ),
      )
      await expect(fetchRange()).resolves.toEqual([])
    })

    it('treats a period without an intensity object as a missing actual', async () => {
      api.respondTo(RANGE_URL, () =>
        jsonResponse({
          data: [
            { from: '2026-11-03T00:00Z', to: '2026-11-03T00:30Z' },
            period('2026-11-03T00:30Z', '2026-11-03T01:00Z', 121),
            {
              from: '2026-11-03T01:00Z',
              to: '2026-11-03T01:30Z',
              intensity: null,
            },
            period('2026-11-03T01:30Z', '2026-11-03T02:00Z', 120),
          ],
        }),
      )
      await expect(fetchRange()).resolves.toEqual([])
    })
  })

  describe('the start of the series and empty ranges', () => {
    it('gives the first hour the series has', async () => {
      // The fixture is the first three half hours of a range of 30 days,
      // which the source never asks for in one request. It is served here
      // for the UTC day the series starts in. The half hours read 140 and
      // 144; the third starts at the end of the range.
      api.serveAs(
        `${NESO_API}/intensity/2017-09-11T00:00Z/2017-09-12T00:00Z`,
        nesoFixture('national-range-first-periods'),
      )

      await expect(
        source.fetch(
          'national',
          utc('2017-09-11T00:00:00.000Z'),
          utc('2017-09-12T00:00:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([hourly('2017-09-11T23:00:00.000Z', 142)])
    })

    it.each([
      ['an empty data list', 'national-range-empty', '2027-06-01'],
      [
        'the JSON literal null',
        'national-range-before-first-period',
        '2015-01-01',
      ],
    ])('gives no points and no error for %s', async (_form, name, day) => {
      const fixture = nesoFixture(name)
      api.serve(fixture)
      const start = utc(`${day}T00:00:00.000Z`)

      await expect(
        source.fetch(
          'national',
          start,
          new Date(start.getTime() + 24 * 3600 * 1000),
          'hour',
        ),
      ).resolves.toEqual([])
      expect(api.urls()).toEqual([fixture.request.url])
    })
  })

  describe('periods that are not half hours', () => {
    it('ignores a period that is not 30 minutes long or not on a half hour', async () => {
      // Written in the recorded shape, with periods the API has not been
      // seen to serve.
      api.respondTo(
        `${NESO_API}/intensity/2026-11-03T00:00Z/2026-11-03T05:00Z`,
        () =>
          jsonResponse({
            data: [
              period('2026-11-03T00:00Z', '2026-11-03T00:30Z', 100),
              period('2026-11-03T00:30Z', '2026-11-03T01:00Z', 110),
              // An hour long.
              period('2026-11-03T01:00Z', '2026-11-03T02:00Z', 120),
              // 30 minutes long, starting at minute 15.
              period('2026-11-03T02:00Z', '2026-11-03T02:30Z', 130),
              period('2026-11-03T02:15Z', '2026-11-03T02:45Z', 140),
              // 15 minutes long, starting on the half hour.
              period('2026-11-03T03:00Z', '2026-11-03T03:30Z', 150),
              period('2026-11-03T03:30Z', '2026-11-03T03:45Z', 160),
              // Ends before it starts.
              period('2026-11-03T04:00Z', '2026-11-03T04:30Z', 170),
              period('2026-11-03T04:30Z', '2026-11-03T04:00Z', 180),
            ],
          }),
      )

      await expect(
        source.fetch(
          'national',
          START,
          utc('2026-11-03T05:00:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([hourly('2026-11-03T00:00:00.000Z', 105)])
    })

    it.each([
      [
        'datetimes without the Z',
        period('2026-11-03T00:30', '2026-11-03T01:00', 110),
      ],
      [
        'a date that does not exist',
        period('2026-13-45T00:30Z', '2026-13-45T01:00Z', 110),
      ],
      [
        'datetimes that are not strings',
        { from: 1793665800000, to: 1793667600000, intensity: { actual: 110 } },
      ],
      ['an entry with no datetimes', { intensity: { actual: 110 } }],
      ['an entry that is not an object', 110],
      ['a null entry', null],
    ])('ignores %s', async (_case, entry) => {
      api.respondTo(RANGE_URL, () =>
        jsonResponse({
          data: [
            period('2026-11-03T00:00Z', '2026-11-03T00:30Z', 128),
            entry,
            period('2026-11-03T01:00Z', '2026-11-03T01:30Z', 121),
            period('2026-11-03T01:30Z', '2026-11-03T02:00Z', 120),
          ],
        }),
      )
      await expect(fetchRange()).resolves.toEqual([
        hourly('2026-11-03T01:00:00.000Z', 120.5),
      ])
    })
  })

  describe('failures', () => {
    // The requests these four record are ones the source never makes (a
    // range of 31 days, a single invalid datetime, a start after the end, an
    // unknown path), so each response is served for an ordinary range. The
    // other two error fixtures are for the regional endpoints, which the
    // source does not call.
    it.each([
      ['error-range-too-long', 400],
      ['error-invalid-datetime', 400],
      ['error-start-after-end', 400],
      ['error-unknown-path', 200],
    ])('throws the message of %s, with HTTP %i', async (name, status) => {
      const fixture = nesoFixture(name)
      const { error } = fixture.response.body as {
        error: { code: string; message: string }
      }
      expect(fixture.response.status).toBe(status)
      api.serveAs(RANGE_URL, fixture)

      await expect(fetchRange()).rejects.toThrow(
        new Error(failed(`HTTP ${status}: ${error.message}`)),
      )
    })

    it('names NESO, the request, the HTTP status and the message of the API', async () => {
      api.serveAs(RANGE_URL, nesoFixture('error-range-too-long'))
      await expect(fetchRange()).rejects.toThrow(
        new Error(
          'NESO Carbon Intensity API: GET /intensity/2026-11-03T00:00Z/2026-11-03T02:00Z failed: HTTP 400: The date range you have specified is greater than 31 days. Please select a smaller date range.',
        ),
      )
    })

    it('treats an error object as a failure although the status is 200', async () => {
      api.serveAs(RANGE_URL, nesoFixture('error-unknown-path'))
      await expect(fetchRange()).rejects.toThrow(
        new Error(
          failed('HTTP 200: Please enter a valid path e.g. /intensity/'),
        ),
      )
    })

    it.each([
      ['a string', 'Internal Server Error', '"Internal Server Error"'],
      ['an object without a message', { code: '500' }, '{"code":"500"}'],
      ['null', null, 'null'],
    ])(
      'shows an error property that is %s as it was sent',
      async (_case, error, shown) => {
        // Not seen from the API, whose error is { code, message }.
        api.respondTo(RANGE_URL, () => jsonResponse({ error, data: [] }, 500))
        await expect(fetchRange()).rejects.toThrow(
          new Error(failed(`HTTP 500: ${shown}`)),
        )
      },
    )

    it.each([
      [
        'a JSON body without an error property',
        () => jsonResponse({ message: 'Forbidden' }, 403),
        403,
      ],
      [
        'a body that is not JSON',
        () => new Response('<html>Bad Gateway</html>', { status: 502 }),
        502,
      ],
      ['no body', () => new Response(null, { status: 503 }), 503],
    ])(
      'throws on a status that is not 2xx, with %s',
      async (_case, respond, status) => {
        api.respondTo(RANGE_URL, respond)
        await expect(fetchRange()).rejects.toThrow(
          new Error(failed(`HTTP ${status}`)),
        )
      },
    )

    it.each([
      ['HTML', '<html>Maintenance</html>'],
      ['JSON that is cut off', '{"data":[{"from":"2026-11-03T00:00Z"'],
      ['empty', ''],
    ])('throws on a 200 whose body is %s', async (_case, text) => {
      api.respondTo(RANGE_URL, () => new Response(text, { status: 200 }))
      await expect(fetchRange()).rejects.toThrow(
        new Error(failed('HTTP 200 with a body that is not JSON')),
      )
    })

    it.each([
      ['an object without data', {}],
      ['an object whose data is an object', { data: { from: 'x' } }],
      ['an object whose data is a string', { data: 'none' }],
      ['an object whose data is null', { data: null }],
      ['a list', []],
      ['a string', 'no data'],
      ['a number', 0],
      ['false', false],
    ])('throws on a 200 whose body is %s', async (_case, body) => {
      api.respondTo(RANGE_URL, () => jsonResponse(body))
      await expect(fetchRange()).rejects.toThrow(
        new Error(failed('HTTP 200 with a body that is not { data: [...] }')),
      )
    })

    it('throws when the network fails, with what fetch reported and why', async () => {
      // The shape Node's fetch rejects with when a connection fails.
      const rejection = new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND api.carbonintensity.org.uk'),
      })
      api.respondTo(RANGE_URL, () => {
        throw rejection
      })

      const error: Error = await fetchRange().catch((thrown) => thrown)

      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe(
        failed(
          'fetch failed: getaddrinfo ENOTFOUND api.carbonintensity.org.uk',
        ),
      )
      expect(error.cause).toBe(rejection)
    })

    it.each([
      ['an error that has no cause', new Error('socket hang up')],
      ['a value that is not an error', 'socket hang up'],
    ])('throws when fetch rejects with %s', async (_case, rejection) => {
      api.respondTo(RANGE_URL, () => {
        throw rejection
      })
      await expect(fetchRange()).rejects.toMatchObject({
        message: failed('socket hang up'),
        cause: rejection,
      })
    })

    it('throws when the body cannot be read to its end', async () => {
      api.respondTo(
        RANGE_URL,
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":['))
                controller.error(new TypeError('terminated'))
              },
            }),
            { status: 200 },
          ),
      )
      await expect(fetchRange()).rejects.toHaveProperty(
        'message',
        failed('terminated'),
      )
    })

    describe('a request that gets no answer', () => {
      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('is given up after the timeout, and the error says so', async () => {
        // The signal the source arms is replaced by one that fires after 10
        // milliseconds, and the stand-in does what fetch does when its
        // signal fires: it rejects with the signal's reason, a TimeoutError.
        const realTimeout = AbortSignal.timeout.bind(AbortSignal)
        const timeout = jest
          .spyOn(AbortSignal, 'timeout')
          .mockImplementation(() => realTimeout(10))
        api.respondTo(
          RANGE_URL,
          (_url, init) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal as AbortSignal
              signal.addEventListener('abort', () => reject(signal.reason))
            }),
        )

        const error: Error = await fetchRange().catch((thrown) => thrown)

        expect(timeout).toHaveBeenCalledWith(NESO_TIMEOUT_MS)
        expect(error.message).toBe(failed('no answer within 30 seconds'))
        expect((error.cause as Error).name).toBe('TimeoutError')
      })
    })
  })

  describe('a range longer than one request may cover', () => {
    const DAY_MS = 24 * 3600 * 1000
    /** A value that is different for every half hour of a 31 day range. */
    const actualOf = (periodStart: Date): number =>
      100 + ((periodStart.getTime() / (30 * 60 * 1000)) % 1500)

    it('is split into consecutive requests of at most 14 days, sent one after another', async () => {
      // The bodies are generated in the recorded shape: the fixtures hold
      // no range this long.
      api.generate(actualOf)
      const start = utc('2026-10-01T00:00:00.000Z')
      const end = utc('2026-11-01T00:00:00.000Z')

      const points = await source.fetch('national', start, end, 'hour')

      expect(NESO_MAX_RANGE_DAYS).toBe(14)
      expect(api.urls()).toEqual([
        `${NESO_API}/intensity/2026-10-01T00:00Z/2026-10-15T00:00Z`,
        `${NESO_API}/intensity/2026-10-15T00:00Z/2026-10-29T00:00Z`,
        `${NESO_API}/intensity/2026-10-29T00:00Z/2026-11-01T00:00Z`,
      ])
      expect(api.mostInFlight()).toBe(1)
      // Every hour once, in order, also the hours on each side of a split.
      expect(points).toHaveLength(31 * 24)
      points.forEach((point, hour) => {
        const periodStart = new Date(start.getTime() + hour * 3600 * 1000)
        const secondHalf = new Date(periodStart.getTime() + 30 * 60 * 1000)
        expect(point).toEqual(
          hourly(
            periodStart.toISOString(),
            (actualOf(periodStart) + actualOf(secondHalf)) / 2,
          ),
        )
      })
    })

    it('asks for exactly 14 days in one request', async () => {
      api.generate(actualOf)
      const start = utc('2026-10-01T00:00:00.000Z')

      const points = await source.fetch(
        'national',
        start,
        new Date(start.getTime() + 14 * DAY_MS),
        'hour',
      )

      expect(api.urls()).toEqual([
        `${NESO_API}/intensity/2026-10-01T00:00Z/2026-10-15T00:00Z`,
      ])
      expect(points).toHaveLength(14 * 24)
    })

    it('stops at the first request that fails', async () => {
      api.generate(actualOf)
      api.serveAs(
        `${NESO_API}/intensity/2026-10-15T00:00Z/2026-10-29T00:00Z`,
        nesoFixture('error-range-too-long'),
      )

      await expect(
        source.fetch(
          'national',
          utc('2026-10-01T00:00:00.000Z'),
          utc('2026-11-01T00:00:00.000Z'),
          'hour',
        ),
      ).rejects.toThrow('HTTP 400')
      expect(api.urls()).toHaveLength(2)
    })

    it('generates bodies that hold the periods the recorded ones hold', () => {
      // A check of the stand-in: for the requests of three fixtures it
      // gives the same half hours as the API did.
      for (const name of [
        'national-range',
        'national-range-plus-one-minute',
        'national-range-missing-actual',
      ]) {
        const fixture = nesoFixture(name)
        const [from, to] = fixture.request.url.split('/').slice(-2)
        const recorded = (fixture.response.body as { data: NesoPeriod[] }).data
        const generated = generatedRange(utc(from), utc(to), () => 100).data
        expect(generated.map((p) => [p.from, p.to])).toEqual(
          recorded.map((p) => [p.from, p.to]),
        )
        expect(Object.keys(generated[0])).toEqual(Object.keys(recorded[0]))
        expect(Object.keys(generated[0].intensity)).toEqual(
          Object.keys(recorded[0].intensity),
        )
      }
    })
  })

  describe('capabilities', () => {
    const at = (now: string) =>
      new NesoSource({ fetch: api.fetch, now: () => utc(now) })

    it('offers hourly, consumption-based data from the first whole hour of the series, without a request', async () => {
      await expect(
        at('2026-11-12T09:30:00.000Z').capabilities('national'),
      ).resolves.toEqual({
        zoneId: 'national',
        granularities: ['hour'],
        earliest: utc('2017-09-11T23:00:00.000Z'),
        latest: utc('2026-11-12T07:00:00.000Z'),
        bases: ['location-consumption'],
        licence: source.licence,
      })
      expect(api.fetch).not.toHaveBeenCalled()
    })

    it('holds back two hours', () => {
      expect(NESO_HOLD_BACK_HOURS).toBe(2)
    })

    it.each([
      // The hour from 10:00 to 11:00 ended less than two hours ago.
      ['2026-11-12T12:59:59.999Z', '2026-11-12T10:00:00.000Z'],
      // It ended exactly two hours ago.
      ['2026-11-12T13:00:00.000Z', '2026-11-12T11:00:00.000Z'],
      ['2026-11-12T13:00:00.001Z', '2026-11-12T11:00:00.000Z'],
      ['2026-11-12T13:59:59.999Z', '2026-11-12T11:00:00.000Z'],
      ['2026-11-12T14:00:00.000Z', '2026-11-12T12:00:00.000Z'],
      // Across midnight.
      ['2026-11-12T01:59:59.999Z', '2026-11-11T23:00:00.000Z'],
      ['2026-11-12T02:00:00.000Z', '2026-11-12T00:00:00.000Z'],
    ])('at %s the data ends at %s', async (now, latest) => {
      const capability = await at(now).capabilities('national')
      expect(capability?.latest).toEqual(utc(latest))
    })

    it('uses the system clock when no clock is given', async () => {
      const before = Date.now()
      const capability = await new NesoSource().capabilities('national')
      const latest = capability?.latest?.getTime() as number
      const holdBackMs = NESO_HOLD_BACK_HOURS * 3600 * 1000
      expect(latest % (3600 * 1000)).toBe(0)
      expect(latest).toBeLessThanOrEqual(Date.now() - holdBackMs)
      expect(latest).toBeGreaterThan(before - holdBackMs - 3600 * 1000)
    })

    it.each(['region-13', 'GB', 'aws:eu-west-2', ''])(
      'has none for the zone "%s"',
      async (zoneId) => {
        await expect(source.capabilities(zoneId)).resolves.toBeNull()
      },
    )
  })

  describe('mapRegion', () => {
    it('holds one zone, the national series, for the grid zone GB', () => {
      expect(NESO_ZONES).toEqual({ GB: 'national' })
    })

    it.each<[CloudProvider, string]>([
      ['AWS', 'eu-west-2'],
      ['AZURE', 'uksouth'],
      ['AZURE', 'ukwest'],
      ['GCP', 'europe-west2'],
    ])('maps %s %s to the national series', (provider, region) => {
      expect(source.mapRegion(provider, region)).toBe('national')
    })

    it.each<[string, CloudProvider, string]>([
      ['a region on another grid', 'AWS', 'eu-west-1'],
      ['a region on another grid', 'GCP', 'us-east4'],
      ['a region whose grid zone is not known', 'GCP', 'asia-east2'],
      ['a region the registry does not list', 'AWS', 'mars-north-1'],
      ['a provider the registry does not cover', 'ALI', 'eu-west-1'],
      [
        'a provider that does not exist',
        'ORACLE' as string as CloudProvider,
        'uk-london-1',
      ],
    ])('has no zone for %s (%s %s)', (_case, provider, region) => {
      expect(source.mapRegion(provider, region)).toBeNull()
    })
  })

  describe('probe', () => {
    const PROBE_URL = `${NESO_API}/intensity`

    it('is reachable when the current half hour is served', async () => {
      const fixture = nesoFixture('national-current')
      api.serve(fixture)

      await expect(source.probe()).resolves.toEqual({
        reachable: true,
        authenticated: true,
      })
      expect(api.urls()).toEqual([fixture.request.url])
      expect(fixture.request.url).toBe(PROBE_URL)
      expect(api.inits()[0]).toEqual({
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': NESO_USER_AGENT },
        signal: expect.any(AbortSignal),
      })
    })

    it('is not reachable when the answer is an error object', async () => {
      api.serveAs(PROBE_URL, nesoFixture('error-unknown-path'))

      await expect(source.probe()).resolves.toEqual({
        reachable: false,
        authenticated: false,
        message:
          'NESO Carbon Intensity API: GET /intensity failed: HTTP 200: Please enter a valid path e.g. /intensity/',
      })
    })

    it('is not reachable when fetch rejects, and does not throw', async () => {
      api.respondTo(PROBE_URL, () => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
        })
      })

      await expect(source.probe()).resolves.toEqual({
        reachable: false,
        authenticated: false,
        message:
          'NESO Carbon Intensity API: GET /intensity failed: fetch failed: connect ECONNREFUSED 127.0.0.1:443',
      })
    })

    it.each([
      ['the JSON literal null', null],
      ['an object without data', { status: 'ok' }],
      ['a list', []],
    ])('is not reachable when the body is %s', async (_case, body) => {
      api.respondTo(PROBE_URL, () => jsonResponse(body))

      await expect(source.probe()).resolves.toEqual({
        reachable: false,
        authenticated: false,
        message:
          'NESO Carbon Intensity API: GET /intensity failed: HTTP 200 with a body that has no data',
      })
    })

    it('does not look at the values it is sent', async () => {
      api.respondTo(PROBE_URL, () => jsonResponse({ data: 'anything' }))
      await expect(source.probe()).resolves.toEqual({
        reachable: true,
        authenticated: true,
      })
    })
  })
})
