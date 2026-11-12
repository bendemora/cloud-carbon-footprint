/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The provisional marker of ADR 0025: a result is provisional when the same
 * configuration could give a better one later, and final otherwise.
 */

import {
  GridIntensityResolver,
  GridIntensityResolverOptions,
  NoIntensityAvailableError,
} from '../GridIntensityResolver'
import { resolveEmissionsFactors } from '../resolveEmissionsFactors'
import { StaticSource } from '../sources/StaticSource'
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { IntensityResolver } from '../types'
import { FakeSource } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const NOON = utc('2026-03-10T12:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const NEXT_DAY_END = utc('2026-03-12T00:00:00.000Z')

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
  let now = utc('2026-11-05T12:00:00.000Z')
  const resolver = new GridIntensityResolver({
    logger: { warn: jest.fn() },
    now: () => now,
    ...options,
  })
  const advanceHours = (hours: number) => {
    now = new Date(now.getTime() + hours * 3600 * 1000)
  }
  return { resolver, advanceHours }
}

const resolveDay = (resolver: IntensityResolver) =>
  resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

describe('provisional results (ADR 0025)', () => {
  describe('a final result has no marker', () => {
    it('when the first source serves the whole period with settled data', async () => {
      const live = new FakeSource({ granularities: ['hour'] })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({ sourceId: 'fake', qualityTier: 'B' })
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when only the static table can serve the region', async () => {
      const { resolver } = createResolver({ sources: [staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when the live source has no zone for the region', async () => {
      const live = new FakeSource({ zones: { 'us-east-1': 'US-MIDA-PJM' } })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when the live source has no data for the zone', async () => {
      const live = new FakeSource({ unavailable: true })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when the live source needs a licence acknowledgement it does not have', async () => {
      const live = new FakeSource({ licence: { id: 'commercial' } })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it("when the period lies before the start of the live source's data", async () => {
      const live = new FakeSource({ earliest: DAY_END })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it("when the only part missing lies before the start of the source's data", async () => {
      const live = new FakeSource({ granularities: ['hour'], earliest: NOON })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      // Half the day is all this source will ever have: estimated, but final.
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        isEstimated: true,
        qualityTier: 'C',
      })
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when a failing source already has the whole period in the store', async () => {
      const live = new FakeSource({ granularities: ['hour'] })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      await resolveDay(resolver)
      live.failFetch = true
      const nextDay = await resolver.resolve(
        'AWS',
        'eu-west-2',
        DAY_END,
        NEXT_DAY_END,
      )
      expect(nextDay.provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
      // The zone's fetches are stopped now, and the first day needs none.
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('fake')
      expect(provenance).not.toHaveProperty('isProvisional')
    })
  })

  describe('a result is provisional', () => {
    it("when the period runs past the end of the source's data", async () => {
      const live = new FakeSource({ latest: NOON })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      // The tier is what it would be without the marker.
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        isEstimated: true,
        qualityTier: 'C',
        isProvisional: true,
      })
    })

    it('when the source has a gap in the period', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        omit: ['2026-03-10T15:00:00.000Z'],
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'C',
        isProvisional: true,
      })
    })

    it('when a gap follows the start of the data inside the period', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        earliest: NOON,
        omit: ['2026-03-10T15:00:00.000Z'],
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        isProvisional: true,
      })
    })

    it('when the live source has published nothing for the period yet and the static table answers', async () => {
      const live = new FakeSource({ latest: DAY_START })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'static',
        isEstimated: false,
        qualityTier: 'D',
        isProvisional: true,
      })
    })

    it('when a request to the live source fails and the static table answers', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'static',
        qualityTier: 'D',
        isProvisional: true,
      })
    })

    it("when the live source's capability probe fails and the static table answers", async () => {
      const live = new FakeSource({ failCapabilities: true })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
    })

    it('when a lower-ranked source covers the period and a higher-ranked one will later', async () => {
      const first = new FakeSource({
        id: 'first',
        granularities: ['hour'],
        latest: NOON,
      })
      const second = new FakeSource({ id: 'second', granularities: ['hour'] })
      const { resolver } = createResolver({
        sources: [first, second, staticSource()],
      })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'second',
        isEstimated: false,
        qualityTier: 'B',
        isProvisional: true,
      })
    })
  })

  describe('preliminary points', () => {
    const lastTwoHours = (start: Date) => start.getUTCHours() >= 22

    it('mark the result provisional, leave the tier alone, and never reach the store', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({
        granularities: ['hour'],
        preliminary: lastTwoHours,
      })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
        store,
      })
      const stored = () => store.get('fake', 'GB', DAY_START, DAY_END, 'hour')

      const first = await resolveDay(resolver)
      expect(first.provenance).toMatchObject({
        sourceId: 'fake',
        isEstimated: false,
        qualityTier: 'B',
        isProvisional: true,
      })
      expect(first.points).toHaveLength(24)
      expect(await stored()).toHaveLength(22)

      // Within the TTL the preliminary points are reused, not fetched again.
      const second = await resolveDay(resolver)
      expect(second.provenance.isProvisional).toBe(true)
      expect(second.points).toHaveLength(24)
      expect(live.fetchCalls).toHaveLength(1)

      // After the TTL they are fetched again, and by then they have settled.
      live.preliminary = () => false
      advanceHours(25)
      const third = await resolveDay(resolver)
      expect(third.provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'B',
      })
      expect(third.provenance).not.toHaveProperty('isProvisional')
      expect(live.fetchCalls[1]).toEqual({
        zoneId: 'GB',
        start: '2026-03-10T22:00:00.000Z',
        end: DAY_END.toISOString(),
        granularity: 'hour',
      })
      expect(await stored()).toHaveLength(24)
    })

    it('are replaced by a settled point another process has stored', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({
        granularities: ['hour'],
        preliminary: lastTwoHours,
      })
      const { resolver } = createResolver({ sources: [live], store })
      const first = await resolveDay(resolver)
      expect(first.provenance.isProvisional).toBe(true)

      await store.put(
        first.points
          .filter((point) => point.isPreliminary)
          .map(({ isPreliminary: _isPreliminary, ...point }) => point),
      )
      const second = await resolveDay(resolver)
      expect(second.provenance).not.toHaveProperty('isProvisional')
      expect(live.fetchCalls).toHaveLength(1)
    })

    it('of a session-retention source stay with its other points', async () => {
      const store = new InMemoryIntensityStore()
      const live = new FakeSource({
        granularities: ['hour'],
        licence: { id: 'open-attribution', retention: 'session' },
        preliminary: lastTwoHours,
      })
      const { resolver } = createResolver({ sources: [live], store })
      const first = await resolveDay(resolver)
      expect(first.provenance.isProvisional).toBe(true)
      expect(first.points).toHaveLength(24)
      expect(
        await store.get('fake', 'GB', DAY_START, DAY_END, 'hour'),
      ).toHaveLength(0)
      await resolveDay(resolver)
      expect(live.fetchCalls).toHaveLength(1)
    })
  })

  describe('when no source can serve the region', () => {
    it('the error says that a configured source could serve it later', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver } = createResolver({ sources: [live] })
      await expect(resolveDay(resolver)).rejects.toMatchObject({
        name: 'NoIntensityAvailableError',
        mayImprove: true,
      })
    })

    it('the error says that none could when no source maps the region', async () => {
      const live = new FakeSource({ zones: {} })
      const { resolver } = createResolver({ sources: [live] })
      await expect(resolveDay(resolver)).rejects.toMatchObject({
        name: 'NoIntensityAvailableError',
        mayImprove: false,
      })
    })

    const failingWith = (error: Error): IntensityResolver => ({
      resolve: () => Promise.reject(error),
    })
    const staticTable = { factors: { 'eu-west-2': 0.000305 } }

    it("the adapter's static fallback is provisional when a source could serve it later", async () => {
      const { provenance } = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
        staticTable,
        {
          resolver: failingWith(
            new NoIntensityAvailableError('AWS', 'eu-west-2', true),
          ),
        },
      )
      expect(provenance).toMatchObject({
        sourceId: 'static',
        qualityTier: 'D',
        isProvisional: true,
      })
    })

    it("the adapter's static fallback is final otherwise", async () => {
      const { provenance } = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        DAY_START,
        DAY_END,
        staticTable,
        {
          resolver: failingWith(
            new NoIntensityAvailableError('AWS', 'eu-west-2'),
          ),
        },
      )
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })
  })
})
