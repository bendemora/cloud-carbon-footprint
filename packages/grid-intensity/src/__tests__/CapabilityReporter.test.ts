/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { GridIntensityCapabilityReporter } from '../CapabilityReporter'
import { GridIntensityResolver } from '../GridIntensityResolver'
import { StaticSource } from '../sources/StaticSource'
import { GridIntensitySource, ProviderRegion } from '../types'
import { FakeSource, FakeSourceOptions } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
// Noon. The last 24 hours touch 9 and 10 November (2 UTC days), the last 30
// days 11 October to 10 November (31), and the last 12 months 10 November
// 2025 to 10 November 2026 (366).
const NOW = utc('2026-11-10T12:00:00.000Z')
const LONDON: ProviderRegion = { provider: 'AWS', region: 'eu-west-2' }

/** A value for the last 24 hours, the last 30 days and the last 12 months. */
const windows = <T>(last24Hours: T, last30Days: T, last12Months: T) => ({
  last24Hours,
  last30Days,
  last12Months,
})
const every = <T>(value: T) => windows(value, value, value)

const staticSource = () =>
  new StaticSource({
    AWS: { factors: { 'eu-west-2': 0.000305, Unknown: 0.0004 } },
  })

const report = (
  sources: GridIntensitySource[],
  options: {
    regions?: ProviderRegion[]
    licenceAcknowledgements?: string[]
    now?: Date
  } = {},
) =>
  new GridIntensityCapabilityReporter({
    resolver: new GridIntensityResolver({
      sources,
      licenceAcknowledgements: options.licenceAcknowledgements,
      now: () => options.now ?? NOW,
    }),
    regions: options.regions ?? [LONDON],
    now: () => options.now ?? NOW,
  }).capabilities()

/** The entry for London of a report on one fake source. */
const londonEntry = async (options: FakeSourceOptions = {}, now?: Date) =>
  (await report([new FakeSource(options)], { now })).regions[0].sources[0]

describe('GridIntensityCapabilityReporter', () => {
  it('reports the static source as tier D for every window, open, with its attribution', async () => {
    const result = await report([staticSource()], {
      regions: [LONDON, { provider: 'AWS', region: 'mars-north-1' }],
    })
    expect(result).toEqual({
      generatedAt: NOW,
      regions: [
        {
          provider: 'AWS',
          region: 'eu-west-2',
          gridZoneId: 'GB',
          sources: [
            {
              sourceId: 'static',
              zoneId: 'aws:eu-west-2',
              licenceState: 'open',
              bestTier: every('D'),
              coverage: every(1),
              attribution:
                'Cloud Carbon Footprint static grid emissions factors (Apache-2.0); sources listed in the CCF methodology, Appendix V',
            },
          ],
        },
        {
          provider: 'AWS',
          region: 'mars-north-1',
          gridZoneId: null,
          sources: [expect.objectContaining({ zoneId: 'aws:Unknown' })],
        },
      ],
    })
  })

  it('lists the sources of a region in configured order', async () => {
    const result = await report([
      new FakeSource({ id: 'live' }),
      staticSource(),
    ])
    expect(result.regions[0].sources.map((s) => s.sourceId)).toEqual([
      'live',
      'static',
    ])
  })

  it('stamps the report with the current time by default', async () => {
    const before = Date.now()
    const result = await new GridIntensityCapabilityReporter({
      resolver: new GridIntensityResolver({ sources: [] }),
      regions: [],
    }).capabilities()
    expect(result.generatedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.generatedAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(result.regions).toEqual([])
  })

  describe('best tier, for the daily usage CCF produces', () => {
    it.each([
      [['hour', 'day'], 'B'],
      [['hour'], 'B'],
      [['month'], 'C'],
      [['year'], 'C'],
    ] as const)(
      'is, for a live source with %j data, tier %s',
      async (granularities, tier) => {
        const entry = await londonEntry({ granularities: [...granularities] })
        expect(entry.bestTier).toEqual(every(tier))
        expect(entry.coverage).toEqual(every(1))
      },
    )

    it('shows how much of each window a short lookback reaches', async () => {
      const entry = await londonEntry({
        earliest: utc('2026-11-01T00:00:00.000Z'),
      })
      expect(entry.bestTier).toEqual(every('B'))
      expect(entry.coverage).toEqual(windows(1, 10 / 31, 10 / 366))
    })

    it('has no tier for a window the data does not reach yet', async () => {
      const entry = await londonEntry({
        latest: utc('2026-11-08T00:00:00.000Z'),
      })
      expect(entry.bestTier).toEqual(windows(null, 'B', 'B'))
      expect(entry.coverage).toEqual(windows(0, 28 / 31, 363 / 366))
    })

    it('counts a day the data covers in part as served, at tier C', async () => {
      const entry = await londonEntry({
        latest: utc('2026-11-09T18:00:00.000Z'),
      })
      expect(entry.bestTier).toEqual(windows('C', 'B', 'B'))
      expect(entry.coverage.last24Hours).toBe(0.5)
    })

    it('takes the last 24 hours at midnight UTC to be the day before alone', async () => {
      const entry = await londonEntry(
        { latest: utc('2026-11-09T00:00:00.000Z') },
        utc('2026-11-10T00:00:00.000Z'),
      )
      expect(entry.bestTier.last24Hours).toBeNull()
      expect(entry.coverage).toEqual(windows(0, 29 / 30, 364 / 365))
    })

    it('needs a whole month of monthly data around the day', async () => {
      const entry = await londonEntry({
        granularities: ['month'],
        latest: utc('2026-11-01T00:00:00.000Z'),
      })
      expect(entry.bestTier).toEqual(windows(null, 'C', 'C'))
      expect(entry.coverage.last30Days).toBe(21 / 31)
    })
  })

  describe('licence state', () => {
    const commercial: FakeSourceOptions = {
      id: 'licensed',
      licence: { id: 'commercial', attribution: 'A licensed dataset' },
    }

    it('is needs-acknowledgement for a commercial source the operator has not listed, with what it would deliver', async () => {
      expect(await londonEntry(commercial)).toMatchObject({
        licenceState: 'needs-acknowledgement',
        bestTier: every('B'),
        attribution: 'A licensed dataset',
      })
    })

    it('is acknowledged once the operator lists the source', async () => {
      const result = await report([new FakeSource(commercial)], {
        licenceAcknowledgements: ['licensed'],
      })
      expect(result.regions[0].sources[0].licenceState).toBe('acknowledged')
    })

    it('is unavailable, with no tier or attribution, for a region the source has no zone for', async () => {
      expect(await londonEntry({ zones: {} })).toEqual({
        sourceId: 'fake',
        zoneId: null,
        licenceState: 'unavailable',
        bestTier: every(null),
        coverage: every(0),
      })
    })

    it.each([
      ['has no capability for the zone', { unavailable: true }],
      ['lists no granularities for the zone', { granularities: [] }],
    ])('is unavailable when the source %s', async (_case, options) => {
      const entry = await londonEntry(options)
      expect(entry).toMatchObject({
        zoneId: 'GB',
        licenceState: 'unavailable',
        bestTier: every(null),
      })
      expect(entry).not.toHaveProperty('attribution')
    })
  })

  describe('errors', () => {
    it("reports a failed capability probe, with the licence state of the source's own licence and no tier", async () => {
      const entry = await londonEntry({
        failCapabilities: true,
        licence: { id: 'commercial' },
      })
      expect(entry).toMatchObject({
        zoneId: 'GB',
        licenceState: 'needs-acknowledgement',
        bestTier: every(null),
        error: 'capability probe failed: capability probe failed',
      })
    })

    it.each([
      [{ reachable: false, authenticated: false }, 'not reachable'],
      [{ reachable: true, authenticated: false }, 'not authenticated'],
      [
        { reachable: true, authenticated: false, message: 'HTTP 401' },
        'HTTP 401',
      ],
    ])(
      'reports the probe answer %j as the error "%s"',
      async (status, error) => {
        expect((await londonEntry({ status })).error).toBe(error)
      },
    )

    it('joins a probe error and the reason the fetches of the zone are stopped', async () => {
      const source = new FakeSource({
        failFetch: true,
        status: { reachable: true, authenticated: false, message: 'HTTP 401' },
      })
      const resolver = new GridIntensityResolver({
        sources: [source, staticSource()],
        now: () => NOW,
      })
      await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-11-09T00:00:00.000Z'),
        utc('2026-11-10T00:00:00.000Z'),
      )
      const result = await new GridIntensityCapabilityReporter({
        resolver,
        regions: [LONDON],
        now: () => NOW,
      }).capabilities()
      expect(result.regions[0].sources.map((s) => s.error)).toEqual([
        'HTTP 401; fetch failed: 401 Unauthorized',
        undefined,
      ])
    })

    it('has no error entry for a source that answers', async () => {
      expect(await londonEntry()).not.toHaveProperty('error')
    })
  })

  describe('grid zone', () => {
    it('gives each region its zone in the grid zone registry, or null when it has none', async () => {
      const result = await report([staticSource()], {
        regions: [
          LONDON,
          { provider: 'GCP', region: 'us-central1' },
          { provider: 'AZURE', region: 'norwayeast' },
          { provider: 'AWS', region: 'Unknown' },
          { provider: 'AWS', region: 'mars-north-1' },
          { provider: 'GCP', region: 'us' },
          { provider: 'ALI', region: 'eu-west-1' },
        ],
      })
      expect(result.regions.map((region) => region.gridZoneId)).toEqual([
        'GB',
        'US-MIDW-MISO',
        'NO-NO1',
        null,
        null,
        null,
        null,
      ])
    })
  })
})
