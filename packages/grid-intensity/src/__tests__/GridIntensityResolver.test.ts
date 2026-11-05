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
import { IntensityPoint, IntensityStore } from '../types'
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

    it('skips a source whose data does not yet reach the end of the period', async () => {
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
      expect(result.provenance.sourceId).toBe('static')
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

    it('carries on without the store when it fails, warning once', async () => {
      const failingStore: IntensityStore = {
        get: jest.fn().mockRejectedValue(new Error('disk full')),
        put: jest.fn().mockRejectedValue(new Error('disk full')),
        purge: jest.fn(),
      }
      const { resolver, logger } = createResolver({
        sources: [new FakeSource({ value: () => 120 })],
        store: failingStore,
      })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
      )
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(result.gCO2ePerKWh).toBe(120)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toContain('disk full')
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

    it('counts several dropped points in the warning', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        value: (start) => (start.getUTCHours() < 2 ? -1 : 100),
      })
      const { resolver, logger } = createResolver({ sources: [live] })
      await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
      expect(logger.warn.mock.calls[0][0]).toContain('Dropped 2 points')
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
})
