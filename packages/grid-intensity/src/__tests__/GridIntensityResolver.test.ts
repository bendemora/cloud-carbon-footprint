/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GridIntensityResolver,
  GridIntensityResolverOptions,
  NoIntensityAvailableError,
} from '../GridIntensityResolver'
import { StaticSource } from '../sources/StaticSource'
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { Granularity, IntensityPoint, IntensityStore } from '../types'
import { FakeSource } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const HOUR_START = utc('2026-03-10T13:00:00.000Z')
const HOUR_END = utc('2026-03-10T14:00:00.000Z')

const staticSource = () =>
  new StaticSource(
    { AWS: { factors: { 'eu-west-2': 0.000305, Unknown: 0.0004 } } },
    () => utc('2026-11-05T12:00:00.000Z'),
  )

const createResolver = (
  options: Partial<GridIntensityResolverOptions> & {
    sources: GridIntensityResolverOptions['sources']
  },
) => {
  const logger = { warn: jest.fn() }
  let now = utc('2026-11-05T12:00:00.000Z')
  const resolver = new GridIntensityResolver({
    logger,
    now: () => now,
    ...options,
  })
  const advanceHours = (hours: number) => {
    now = new Date(now.getTime() + hours * 3600 * 1000)
  }
  return { resolver, logger, advanceHours }
}

describe('GridIntensityResolver', () => {
  describe('with only the static source', () => {
    it('returns the static factor in grams with tier D provenance', async () => {
      const { resolver } = createResolver({ sources: [staticSource()] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.gCO2ePerKWh).toBe(305)
      expect(result.provenance).toEqual({
        sourceId: 'static',
        zoneId: 'aws:eu-west-2',
        granularity: 'year',
        basis: 'location-production',
        factorType: 'direct',
        isEstimated: false,
        licenceId: 'open-attribution',
        qualityTier: 'D',
        gCO2ePerKWh: 305,
        modelVersion: 'unversioned',
      })
    })

    it('uses the configured model version', async () => {
      const { resolver } = createResolver({
        sources: [staticSource()],
        modelVersion: '1.2.3',
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.modelVersion).toBe('1.2.3')
    })
  })

  describe('choosing a source', () => {
    it('uses the first source in order that maps the region', async () => {
      const unmapped = new FakeSource({ id: 'unmapped', zones: {} })
      const live = new FakeSource({ id: 'live', value: () => 150 })
      const { resolver } = createResolver({
        sources: [unmapped, live, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'live',
        zoneId: 'GB',
        qualityTier: 'B',
      })
      expect(result.gCO2ePerKWh).toBe(150)
      expect(unmapped.capabilityCalls).toBe(0)
    })

    it('gives tier A for hourly intensity on hourly usage', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        value: (start) => start.getUTCHours() * 10,
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        HOUR_START,
        HOUR_END,
      )
      expect(result.gCO2ePerKWh).toBe(130)
      expect(result.provenance).toMatchObject({
        granularity: 'hour',
        qualityTier: 'A',
        gCO2ePerKWh: 130,
      })
    })

    it('requests daily values for daily usage when the source offers them', async () => {
      const live = new FakeSource({ granularities: ['hour', 'day'] })
      const { resolver } = createResolver({ sources: [live] })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.fetchCalls).toEqual([
        {
          zoneId: 'GB',
          start: DAY_START.toISOString(),
          end: DAY_END.toISOString(),
          granularity: 'day',
        },
      ])
    })

    it('time-weights hourly values over daily usage when the source has no daily values', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        value: (start) => start.getUTCHours(),
      })
      const { resolver } = createResolver({ sources: [live] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(live.fetchCalls[0].granularity).toBe('hour')
      expect(result.gCO2ePerKWh).toBe(11.5)
      expect(result.points).toHaveLength(24)
      expect(result.provenance).toMatchObject({
        granularity: 'hour',
        qualityTier: 'B',
      })
    })

    it('prefers a later source with fine enough data over an earlier coarse one', async () => {
      const monthly = new FakeSource({
        id: 'monthly',
        granularities: ['month'],
      })
      const daily = new FakeSource({ id: 'daily', granularities: ['day'] })
      const { resolver } = createResolver({ sources: [monthly, daily] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('daily')
      expect(monthly.fetchCalls).toHaveLength(0)
    })

    it('falls back to coarser data when nothing finer exists, and the tier drops', async () => {
      const monthly = new FakeSource({
        id: 'monthly',
        granularities: ['month'],
      })
      const { resolver } = createResolver({
        sources: [staticSource(), monthly],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'monthly',
        granularity: 'month',
        qualityTier: 'C',
      })
    })

    it('skips a source whose lookback does not cover the period', async () => {
      const recent = new FakeSource({
        id: 'recent',
        earliest: utc('2026-08-01T00:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [recent, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('static')
      expect(recent.fetchCalls).toHaveLength(0)
    })

    it("uses stored points from before the source's lookback window", async () => {
      const store = new InMemoryIntensityStore()
      await store.put(
        await new FakeSource({ value: () => 180 }).fetch(
          'GB',
          DAY_START,
          DAY_END,
          'day',
        ),
      )
      const recent = new FakeSource({
        earliest: utc('2026-08-01T00:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [recent, staticSource()],
        store,
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'B',
      })
      expect(result.gCO2ePerKWh).toBe(180)
      expect(recent.fetchCalls).toHaveLength(0)
    })

    it("serves the part of a period before the end of the source's data from its finest data, marked estimated", async () => {
      const lagging = new FakeSource({
        id: 'lagging',
        latest: utc('2026-03-10T12:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [lagging, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(lagging.fetchCalls).toEqual([
        {
          zoneId: 'GB',
          start: DAY_START.toISOString(),
          end: '2026-03-10T12:00:00.000Z',
          granularity: 'hour',
        },
      ])
      expect(result.points).toHaveLength(12)
      expect(result.provenance).toMatchObject({
        sourceId: 'lagging',
        granularity: 'hour',
        isEstimated: true,
        qualityTier: 'C',
      })
    })

    it("serves a month that runs past the end of the source's data from daily data", async () => {
      const lagging = new FakeSource({
        id: 'lagging',
        latest: utc('2026-03-10T12:00:00.000Z'),
      })
      const { resolver } = createResolver({ sources: [lagging] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-01T00:00:00.000Z'),
        utc('2026-04-01T00:00:00.000Z'),
      )
      expect(lagging.fetchCalls).toEqual([
        {
          zoneId: 'GB',
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-10T00:00:00.000Z',
          granularity: 'day',
        },
      ])
      expect(result.provenance).toMatchObject({
        granularity: 'day',
        isEstimated: true,
      })
    })

    it('prefers a later source that covers the whole period over an earlier partial one', async () => {
      const partial = new FakeSource({
        id: 'partial',
        granularities: ['hour'],
        earliest: utc('2026-03-10T12:00:00.000Z'),
        value: () => 300,
      })
      const full = new FakeSource({ id: 'full', value: () => 100 })
      const { resolver } = createResolver({
        sources: [partial, full, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'full',
        qualityTier: 'B',
      })
      expect(result.gCO2ePerKWh).toBe(100)
    })

    it('takes the partial result with the most coverage when no source covers the whole period', async () => {
      const quarter = new FakeSource({
        id: 'quarter',
        granularities: ['hour'],
        earliest: utc('2026-03-10T18:00:00.000Z'),
      })
      const half = new FakeSource({
        id: 'half',
        granularities: ['hour'],
        earliest: utc('2026-03-10T12:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [quarter, half, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'half',
        isEstimated: true,
        qualityTier: 'C',
      })
    })

    it('skips a source whose data ends before the period starts', async () => {
      const stale = new FakeSource({
        id: 'stale',
        latest: utc('2026-03-01T00:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [stale, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('static')
      expect(stale.fetchCalls).toHaveLength(0)
    })

    it('counts daily data as fine enough for a week, and monthly data as too coarse', async () => {
      const monthly = new FakeSource({
        id: 'monthly',
        granularities: ['month'],
      })
      const daily = new FakeSource({ id: 'daily', granularities: ['day'] })
      const { resolver } = createResolver({ sources: [monthly, daily] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-04-06T00:00:00.000Z'),
        utc('2026-04-13T00:00:00.000Z'),
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'daily',
        qualityTier: 'B',
      })
      expect(monthly.fetchCalls).toHaveLength(0)
    })

    it('counts monthly data as fine enough for a quarter, and annual data as too coarse', async () => {
      const monthly = new FakeSource({
        id: 'monthly',
        granularities: ['month'],
      })
      const { resolver } = createResolver({
        sources: [staticSource(), monthly],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-04-01T00:00:00.000Z'),
        utc('2026-07-01T00:00:00.000Z'),
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'monthly',
        granularity: 'month',
      })
      expect(result.points).toHaveLength(3)
    })

    it('throws NoIntensityAvailableError when no source can serve the region', async () => {
      const { resolver } = createResolver({ sources: [staticSource()] })
      await expect(
        resolver.resolve('GCP', 'europe-west2', DAY_START, DAY_END),
      ).rejects.toBeInstanceOf(NoIntensityAvailableError)
    })

    it('rejects an empty range', async () => {
      const { resolver } = createResolver({ sources: [staticSource()] })
      await expect(
        resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_START),
      ).rejects.toThrow(RangeError)
    })
  })

  describe('defaults and edge cases', () => {
    it('works with default options', async () => {
      const resolver = new GridIntensityResolver({ sources: [staticSource()] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.qualityTier).toBe('D')
    })

    it('skips a source whose capability lists no granularities', async () => {
      const none = new FakeSource({ id: 'none', granularities: [] })
      const { resolver } = createResolver({ sources: [none, staticSource()] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('static')
      expect(none.fetchCalls).toHaveLength(0)
    })

    it('reports a failure that is not an Error object', async () => {
      const live = new FakeSource()
      live.fetch = () => Promise.reject('socket hang up')
      const { resolver, logger } = createResolver({
        sources: [live, staticSource()],
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(logger.warn.mock.calls[0][0]).toContain('socket hang up')
    })
  })

  describe('licence gating', () => {
    const commercial = () =>
      new FakeSource({ id: 'electricitymaps', licence: { id: 'commercial' } })

    it('skips a commercial source the operator has not acknowledged, warning once', async () => {
      const source = commercial()
      const { resolver, logger } = createResolver({
        sources: [source, staticSource()],
      })
      for (let i = 0; i < 2; i++) {
        const result = await resolver.resolve(
          'AWS',
          'eu-west-2',
          DAY_START,
          DAY_END,
        )
        expect(result.provenance.sourceId).toBe('static')
      }
      expect(source.fetchCalls).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toContain(
        'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
      )
    })

    it('uses a commercial source the operator has acknowledged', async () => {
      const { resolver } = createResolver({
        sources: [commercial(), staticSource()],
        licenceAcknowledgements: ['electricitymaps'],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'electricitymaps',
        licenceId: 'commercial',
      })
    })
  })

  describe('store', () => {
    it('fetches only the periods the store lacks and persists them', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({ granularities: ['hour'] })
      const stored: IntensityPoint[] = (
        await live.fetch(
          'GB',
          utc('2026-03-10T06:00:00.000Z'),
          utc('2026-03-10T18:00:00.000Z'),
          'hour',
        )
      ).map((p) => ({ ...p, gCO2ePerKWh: 200 }))
      await store.put(stored)
      live.fetchCalls.length = 0

      const { resolver } = createResolver({ sources: [live], store })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(live.fetchCalls.map((c) => [c.start, c.end])).toEqual([
        ['2026-03-10T00:00:00.000Z', '2026-03-10T06:00:00.000Z'],
        ['2026-03-10T18:00:00.000Z', '2026-03-11T00:00:00.000Z'],
      ])
      // 12 stored hours at 200 and 12 fetched hours at 100
      expect(result.gCO2ePerKWh).toBe(150)
      await expect(
        store.get('fake', 'GB', DAY_START, DAY_END, 'hour'),
      ).resolves.toHaveLength(24)
    })

    it('does not call the source when the store covers the period', async () => {
      const live = new FakeSource()
      const { resolver } = createResolver({ sources: [live] })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.fetchCalls).toHaveLength(1)
    })

    it('does not persist points from a source with session retention', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({ licence: { retention: 'session' } })
      const { resolver } = createResolver({ sources: [live], store })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('fake')
      await expect(
        store.get('fake', 'GB', DAY_START, DAY_END, 'day'),
      ).resolves.toEqual([])
    })

    it('keeps points from a session-retention source in memory for the TTL only', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({ licence: { retention: 'session' } })
      const { resolver, advanceHours } = createResolver({
        sources: [live],
        store,
        capabilityTtlHours: 24,
      })
      for (let row = 0; row < 3; row++)
        await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.fetchCalls).toHaveLength(1)
      await expect(
        store.get('fake', 'GB', DAY_START, DAY_END, 'day'),
      ).resolves.toEqual([])

      advanceHours(25)
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.fetchCalls).toHaveLength(2)
    })

    it('releases session-retention points on the first call after the TTL, whatever it resolves', async () => {
      const live = new FakeSource({ licence: { retention: 'session' } })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
        capabilityTtlHours: 24,
      })
      const session = () =>
        (resolver as unknown as { session: IntensityStore }).session.get(
          'fake',
          'GB',
          DAY_START,
          DAY_END,
          'day',
        )
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      await expect(session()).resolves.toHaveLength(1)
      advanceHours(25)
      await resolver
        .resolve('GCP', 'europe-west2', DAY_START, DAY_END)
        .catch(() => undefined)
      await expect(session()).resolves.toEqual([])
    })

    it('reads the store after the first probe of a fresh resolver fails', async () => {
      const store = new InMemoryIntensityStore()
      await createResolver({
        sources: [new FakeSource({ value: () => 42 })],
        store,
      }).resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

      const failing = new FakeSource({ failCapabilities: true })
      const { resolver, logger } = createResolver({
        sources: [failing, staticSource()],
        store,
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        sourceId: 'fake',
        granularity: 'day',
        qualityTier: 'B',
      })
      expect(result.gCO2ePerKWh).toBe(42)
      expect(failing.fetchCalls).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('warns about a store failure again after the store has worked in between', async () => {
      const store: IntensityStore = {
        get: jest
          .fn()
          .mockRejectedValueOnce(new Error('timeout'))
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error('timeout again')),
        put: jest.fn().mockResolvedValue(undefined),
        purge: jest.fn(),
      }
      const { resolver, logger } = createResolver({
        sources: [new FakeSource({ licence: { retention: 'unlimited' } })],
        store,
      })
      for (let row = 0; row < 3; row++)
        await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(logger.warn.mock.calls.map(([message]) => message)).toEqual([
        'Grid intensity store read failed for source fake, zone GB: timeout',
        'Grid intensity store read failed for source fake, zone GB: timeout again',
      ])
    })

    it('neither reads nor writes the store for the static source', async () => {
      const store: IntensityStore = {
        get: jest.fn().mockResolvedValue([]),
        put: jest.fn(),
        purge: jest.fn(),
      }
      const { resolver } = createResolver({ sources: [staticSource()], store })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.gCO2ePerKWh).toBe(305)
      expect(store.get).not.toHaveBeenCalled()
      expect(store.put).not.toHaveBeenCalled()
    })

    it('carries on without the store when it fails, warning once per operation and zone', async () => {
      const failingStore: IntensityStore = {
        get: jest.fn().mockRejectedValue(new Error('disk full')),
        put: jest.fn().mockRejectedValue(new Error('disk full')),
        purge: jest.fn(),
      }
      const { resolver, logger } = createResolver({
        sources: [
          new FakeSource({
            value: () => 120,
            zones: { 'eu-west-2': 'GB', 'eu-west-3': 'FR' },
          }),
        ],
        store: failingStore,
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      await resolver.resolve('AWS', 'eu-west-3', DAY_START, DAY_END)
      expect(result.gCO2ePerKWh).toBe(120)
      expect(logger.warn.mock.calls.map(([message]) => message)).toEqual([
        'Grid intensity store read failed for source fake, zone GB: disk full',
        'Grid intensity store write failed for source fake, zone GB: disk full',
        'Grid intensity store read failed for source fake, zone FR: disk full',
        'Grid intensity store write failed for source fake, zone FR: disk full',
      ])
    })
  })

  describe('failures', () => {
    it('falls through to the next source when a fetch fails, and negative-caches the zone', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver, logger, advanceHours } = createResolver({
        sources: [live, staticSource()],
        capabilityTtlHours: 24,
      })
      const first = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      const second = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-11T00:00:00.000Z'),
        utc('2026-03-12T00:00:00.000Z'),
      )
      expect(first.provenance.sourceId).toBe('static')
      expect(second.provenance.sourceId).toBe('static')
      expect(live.fetchCalls).toHaveLength(1)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toContain('401 Unauthorized')

      live.failFetch = false
      advanceHours(25)
      const later = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(later.provenance.sourceId).toBe('fake')
    })

    it('falls through when the capability probe fails, and negative-caches it', async () => {
      const live = new FakeSource({ failCapabilities: true })
      const { resolver, logger } = createResolver({
        sources: [live, staticSource()],
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('static')
      expect(live.capabilityCalls).toBe(1)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('serves stored points for a zone whose fetches are failing', async () => {
      const live = new FakeSource({ value: () => 150 })
      const { resolver } = createResolver({
        sources: [live, staticSource()],
        store: new InMemoryIntensityStore(),
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      live.failFetch = true
      const failed = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-11T00:00:00.000Z'),
        utc('2026-03-12T00:00:00.000Z'),
      )
      const stored = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(failed.provenance.sourceId).toBe('static')
      expect(stored.provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'B',
      })
      expect(stored.gCO2ePerKWh).toBe(150)
      expect(live.fetchCalls).toHaveLength(2)
    })

    it('keeps serving stored points when a later capability probe fails', async () => {
      const live = new FakeSource({ value: () => 150 })
      const { resolver, logger, advanceHours } = createResolver({
        sources: [live, staticSource()],
        capabilityTtlHours: 24,
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      advanceHours(25)
      live.failCapabilities = true
      const stored = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      const missing = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-11T00:00:00.000Z'),
        utc('2026-03-12T00:00:00.000Z'),
      )
      expect(stored.provenance.sourceId).toBe('fake')
      expect(missing.provenance.sourceId).toBe('static')
      expect(live.capabilityCalls).toBe(2)
      expect(live.fetchCalls).toHaveLength(1)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('logs a failure again when it recurs after the TTL', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver, logger, advanceHours } = createResolver({
        sources: [live, staticSource()],
        capabilityTtlHours: 24,
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      advanceHours(25)
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.fetchCalls).toHaveLength(2)
      expect(logger.warn).toHaveBeenCalledTimes(2)
    })

    it('caches a successful capability answer for the TTL', async () => {
      const live = new FakeSource()
      const { resolver, advanceHours } = createResolver({
        sources: [live],
        capabilityTtlHours: 1,
      })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-11T00:00:00.000Z'),
        utc('2026-03-12T00:00:00.000Z'),
      )
      expect(live.capabilityCalls).toBe(1)
      advanceHours(2)
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(live.capabilityCalls).toBe(2)
    })
  })

  describe('data quality', () => {
    it('drops points outside 0 to 1500 gCO2e/kWh and warns', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        value: (start) => (start.getUTCHours() === 0 ? 5000 : 100),
      })
      const { resolver, logger } = createResolver({ sources: [live] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.gCO2ePerKWh).toBe(100)
      expect(result.points).toHaveLength(23)
      expect(logger.warn.mock.calls[0][0]).toContain('Dropped 1 point from')
    })

    it('does not bound-check a source whose values come from code', async () => {
      // CCF's GCP multi-region factors are sums across data centres
      // (us: 3810 gCO2e/kWh), which the fetched-data bound would reject.
      const source = new StaticSource({ GCP: { factors: { us: 0.00381 } } })
      const { resolver, logger } = createResolver({ sources: [source] })
      const result = await resolver.resolve('GCP', 'us', DAY_START, DAY_END)
      expect(result.gCO2ePerKWh).toBe(3810)
      expect(result.provenance).toMatchObject({
        sourceId: 'static',
        zoneId: 'gcp:us',
        isEstimated: false,
        qualityTier: 'D',
      })
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('counts several dropped points in the warning', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        value: (start) => (start.getUTCHours() < 2 ? -1 : 100),
      })
      const { resolver, logger } = createResolver({ sources: [live] })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(logger.warn.mock.calls[0][0]).toContain('Dropped 2 points')
    })

    it('drops points that are not whole periods of the zone, so overlaps cannot hide a gap', async () => {
      class Untidy extends FakeSource {
        async fetch(
          zoneId: string,
          start: Date,
          end: Date,
          granularity: Granularity,
        ): Promise<IntensityPoint[]> {
          const points = await super.fetch(zoneId, start, end, granularity)
          return [
            ...points,
            {
              ...points[12],
              periodStart: utc('2026-03-10T12:30:00.000Z'),
              periodEnd: utc('2026-03-10T13:30:00.000Z'),
              gCO2ePerKWh: 800,
            },
            { ...points[1], zoneId: 'FR', gCO2ePerKWh: 900 },
            { ...points[2], granularity: 'day', gCO2ePerKWh: 900 },
            { ...points[3], sourceId: 'other', gCO2ePerKWh: 900 },
          ]
        }
      }
      const { resolver, logger } = createResolver({
        sources: [new Untidy({ granularities: ['hour'] })],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.gCO2ePerKWh).toBe(100)
      expect(result.points).toHaveLength(24)
      expect(logger.warn).toHaveBeenCalledWith(
        'Dropped 4 points from grid intensity source fake for zone GB that are not whole UTC hour periods of that zone.',
      )
    })

    it('marks a partially covered period as estimated, tier C', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        omit: ['2026-03-10T05:00:00.000Z'],
      })
      const { resolver } = createResolver({ sources: [live] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        isEstimated: true,
        qualityTier: 'C',
      })
    })

    it('carries the estimated flag of the source points', async () => {
      const live = new FakeSource({ isEstimated: true })
      const { resolver } = createResolver({ sources: [live] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance).toMatchObject({
        isEstimated: true,
        qualityTier: 'C',
      })
    })

    it('falls through when a source returns no usable points', async () => {
      const empty = new FakeSource({
        id: 'empty',
        granularities: ['day'],
        omit: ['2026-03-10T00:00:00.000Z'],
      })
      const { resolver } = createResolver({
        sources: [empty, staticSource()],
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      expect(result.provenance.sourceId).toBe('static')
    })
  })

  describe('sourceViews', () => {
    it('lists every source in configured order with its zone and capability for the region', async () => {
      const unmapped = new FakeSource({ id: 'unmapped', zones: {} })
      const live = new FakeSource({ id: 'live' })
      const { resolver } = createResolver({
        sources: [unmapped, live, staticSource()],
      })
      const views = await resolver.sourceViews('AWS', 'eu-west-2')
      expect(views).toEqual([
        {
          source: unmapped,
          zoneId: null,
          capability: null,
          acknowledged: false,
          status: { reachable: true, authenticated: true },
        },
        {
          source: live,
          zoneId: 'GB',
          capability: {
            zoneId: 'GB',
            granularities: ['hour', 'day'],
            bases: ['location-consumption'],
            licence: live.licence,
          },
          acknowledged: false,
          status: { reachable: true, authenticated: true },
        },
        {
          source: expect.objectContaining({ id: 'static' }),
          zoneId: 'aws:eu-west-2',
          capability: expect.objectContaining({ granularities: ['year'] }),
          acknowledged: false,
          status: { reachable: true, authenticated: true },
        },
      ])
      expect(unmapped.capabilityCalls).toBe(0)
    })

    it('says why the fetches of a zone are stopped, until the TTL has gone by', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
        capabilityTtlHours: 24,
      })
      const before = await resolver.sourceViews('AWS', 'eu-west-2')
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      const during = await resolver.sourceViews('AWS', 'eu-west-2')
      advanceHours(25)
      const after = await resolver.sourceViews('AWS', 'eu-west-2')

      expect(before[0].failure).toBeUndefined()
      expect(during[0].failure).toBe('fetch failed: 401 Unauthorized')
      expect(during[1].failure).toBeUndefined()
      expect(after[0].failure).toBeUndefined()
    })

    it('has no capability for a source whose first probe of the zone failed, and asks once per TTL', async () => {
      const live = new FakeSource({ failCapabilities: true })
      const { resolver } = createResolver({ sources: [live] })
      await resolver.sourceViews('AWS', 'eu-west-2')
      const [view] = await resolver.sourceViews('AWS', 'eu-west-2')

      expect(view.capability).toBeNull()
      expect(view.failure).toBe(
        'capability probe failed: capability probe failed',
      )
      expect(live.capabilityCalls).toBe(1)
    })

    it('uses the capability answer the resolver already holds', async () => {
      const live = new FakeSource()
      const { resolver } = createResolver({ sources: [live] })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      await resolver.sourceViews('AWS', 'eu-west-2')
      expect(live.capabilityCalls).toBe(1)
    })

    it('keeps the last capability, with the failure, when a later probe fails', async () => {
      const live = new FakeSource({ granularities: ['day'] })
      const { resolver, advanceHours } = createResolver({
        sources: [live],
        capabilityTtlHours: 24,
      })
      await resolver.sourceViews('AWS', 'eu-west-2')
      advanceHours(25)
      live.failCapabilities = true
      const [view] = await resolver.sourceViews('AWS', 'eu-west-2')

      expect(view.capability).toMatchObject({ granularities: ['day'] })
      expect(view.failure).toBe(
        'capability probe failed: capability probe failed',
      )
    })

    it('marks the sources the operator has acknowledged', async () => {
      const { resolver } = createResolver({
        sources: [
          new FakeSource({ id: 'electricitymaps' }),
          new FakeSource({ id: 'other' }),
        ],
        licenceAcknowledgements: ['electricitymaps'],
      })
      const views = await resolver.sourceViews('AWS', 'eu-west-2')
      expect(views.map((view) => view.acknowledged)).toEqual([true, false])
    })

    it("gives each source's probe answer, asking it once per TTL", async () => {
      const status = {
        reachable: true,
        authenticated: false,
        message: 'HTTP 401',
      }
      const live = new FakeSource({ status })
      const { resolver, advanceHours } = createResolver({
        sources: [live],
        capabilityTtlHours: 24,
      })
      const [first] = await resolver.sourceViews('AWS', 'eu-west-2')
      await resolver.sourceViews('AWS', 'eu-west-3')
      expect(first.status).toEqual(status)
      expect(live.probeCalls).toBe(1)

      advanceHours(25)
      await resolver.sourceViews('AWS', 'eu-west-2')
      expect(live.probeCalls).toBe(2)
    })

    it('reports a probe that throws as a source that cannot be reached', async () => {
      const { resolver } = createResolver({
        sources: [new FakeSource({ failProbe: true })],
      })
      const [view] = await resolver.sourceViews('AWS', 'eu-west-2')
      expect(view.status).toEqual({
        reachable: false,
        authenticated: false,
        message: 'getaddrinfo ENOTFOUND',
      })
    })
  })
})
