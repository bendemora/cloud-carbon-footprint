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
import {
  Granularity,
  IntensityPoint,
  IntensityResolver,
  IntensityStore,
} from '../types'
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

    it('do not replace a settled point the store holds', async () => {
      // A source that answers with more than it was asked for: two hours
      // before the range, all preliminary.
      class Overreaching extends FakeSource {
        async fetch(
          zoneId: string,
          start: Date,
          end: Date,
          granularity: Granularity,
        ): Promise<IntensityPoint[]> {
          const earlier = new Date(start.getTime() - 2 * 3600 * 1000)
          return super.fetch(zoneId, earlier, end, granularity)
        }
      }
      const store = new InMemoryIntensityStore()
      const settled = new FakeSource({
        granularities: ['hour'],
        value: () => 200,
        omit: ['2026-03-10T23:00:00.000Z'],
      })
      await resolveDay(createResolver({ sources: [settled], store }).resolver)

      const live = new Overreaching({
        granularities: ['hour'],
        value: () => 100,
        preliminary: () => true,
      })
      const { resolver } = createResolver({ sources: [live], store })
      const result = await resolveDay(resolver)
      // 23 settled hours at 200 and the one preliminary hour at 100.
      expect(result.gCO2ePerKWh).toBeCloseTo((23 * 200 + 100) / 24, 10)
      expect(result.points.filter((p) => p.isPreliminary)).toHaveLength(1)
      expect(result.provenance.isProvisional).toBe(true)
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

  describe("the start of a source's data", () => {
    const AUGUST = utc('2026-08-01T00:00:00.000Z')

    it('makes an earlier period final even while the source is failing', async () => {
      const live = new FakeSource({ granularities: ['hour'], earliest: AUGUST })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      live.failFetch = true
      const september = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-09-01T00:00:00.000Z'),
        utc('2026-09-02T00:00:00.000Z'),
      )
      expect(september.provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
      // The failure is remembered, but March is not the source's to serve.
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('is taken at the first whole period the resolver can ask for: a day asked by the day', async () => {
      // Hourly data exists from noon, but a day of usage is asked for by the
      // day, and that day starts before the data does.
      const live = new FakeSource({
        granularities: ['hour', 'day'],
        earliest: NOON,
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolveDay(resolver)
      expect(live.fetchCalls).toHaveLength(0)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('is taken at the first whole period the resolver can ask for: a start inside an hour', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        earliest: utc('2026-03-10T12:30:00.000Z'),
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const result = await resolveDay(resolver)
      // 13:00 to midnight is all this source will ever have for the day.
      expect(result.points).toHaveLength(11)
      expect(result.provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'C',
      })
      expect(result.provenance).not.toHaveProperty('isProvisional')
    })

    it('is taken at the first whole period the resolver can ask for: a week asked by the day', async () => {
      const live = new FakeSource({
        granularities: ['day'],
        earliest: utc('2026-04-08T05:00:00.000Z'),
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const result = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-04-06T00:00:00.000Z'),
        utc('2026-04-13T00:00:00.000Z'),
      )
      expect(result.points).toHaveLength(4)
      expect(result.provenance.sourceId).toBe('fake')
      expect(result.provenance).not.toHaveProperty('isProvisional')
    })

    it('is taken at the first whole period the resolver can ask for: a month that began before it', async () => {
      const monthly = new FakeSource({
        granularities: ['month'],
        earliest: utc('2026-03-05T00:00:00.000Z'),
      })
      const { resolver } = createResolver({
        sources: [monthly, staticSource()],
      })
      const { provenance } = await resolveDay(resolver)
      expect(monthly.fetchCalls).toHaveLength(0)
      expect(provenance.sourceId).toBe('static')
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('does not make a result final when the store could not be read', async () => {
      // The store may hold points from before the lookback; they were not
      // seen, so the static answer may be worse than the store allows.
      const unreadable: IntensityStore = {
        get: () => Promise.reject(new Error('ECONNREFUSED')),
        put: async () => undefined,
        purge: async () => 0,
      }
      const live = new FakeSource({ granularities: ['hour'], earliest: AUGUST })
      const { resolver } = createResolver({
        sources: [live, staticSource()],
        store: unreadable,
      })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
    })
  })

  describe('every source tried for the period counts', () => {
    it('a coarser source that has not published yet, with the static table answering', async () => {
      const monthly = new FakeSource({
        granularities: ['month'],
        latest: utc('2026-03-01T00:00:00.000Z'),
      })
      const { resolver, advanceHours } = createResolver({
        sources: [monthly, staticSource()],
      })
      const before = await resolveDay(resolver)
      expect(before.provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
      // Once the month is published the monthly value is the final answer.
      monthly.latest = utc('2026-04-01T00:00:00.000Z')
      advanceHours(25)
      const after = await resolveDay(resolver)
      expect(after.provenance).toMatchObject({
        sourceId: 'fake',
        granularity: 'month',
        qualityTier: 'C',
      })
      expect(after.provenance).not.toHaveProperty('isProvisional')
    })

    it('a source after the one that answered in part, when it fails', async () => {
      // The first source will never have more than the afternoon, so on its
      // own its partial answer is final. A failing second source could
      // still cover the day.
      const first = new FakeSource({
        id: 'first',
        granularities: ['hour'],
        earliest: NOON,
      })
      const second = new FakeSource({
        id: 'second',
        granularities: ['hour'],
        failFetch: true,
      })
      const { resolver } = createResolver({
        sources: [first, second, staticSource()],
      })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'first',
        qualityTier: 'C',
        isProvisional: true,
      })
    })
  })

  describe('other usage periods', () => {
    it('a week that runs past the end of the data is provisional', async () => {
      const live = new FakeSource({
        granularities: ['day'],
        latest: utc('2026-04-09T00:00:00.000Z'),
      })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const { provenance } = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-04-06T00:00:00.000Z'),
        utc('2026-04-13T00:00:00.000Z'),
      )
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        isEstimated: true,
        isProvisional: true,
      })
    })

    it('an hour served in full is final, and an hour not published yet is provisional', async () => {
      const live = new FakeSource({ granularities: ['hour'], latest: NOON })
      const { resolver } = createResolver({ sources: [live, staticSource()] })
      const served = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-10T09:00:00.000Z'),
        utc('2026-03-10T10:00:00.000Z'),
      )
      expect(served.provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'A',
      })
      expect(served.provenance).not.toHaveProperty('isProvisional')
      const notYet = await resolver.resolve(
        'AWS',
        'eu-west-2',
        utc('2026-03-10T15:00:00.000Z'),
        utc('2026-03-10T16:00:00.000Z'),
      )
      expect(notYet.provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
    })
  })

  describe('the marker goes away', () => {
    it('when a gap fills', async () => {
      const live = new FakeSource({
        granularities: ['hour'],
        omit: ['2026-03-10T15:00:00.000Z'],
      })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
      })
      expect((await resolveDay(resolver)).provenance.isProvisional).toBe(true)
      live.omit = []
      advanceHours(25)
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({ sourceId: 'fake', qualityTier: 'B' })
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when the end of the data moves past the period', async () => {
      const live = new FakeSource({ latest: NOON })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
      })
      expect((await resolveDay(resolver)).provenance.isProvisional).toBe(true)
      live.latest = DAY_END
      advanceHours(25)
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({ sourceId: 'fake', qualityTier: 'B' })
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('when a failing source answers again', async () => {
      const live = new FakeSource({ failFetch: true })
      const { resolver, advanceHours } = createResolver({
        sources: [live, staticSource()],
      })
      expect((await resolveDay(resolver)).provenance).toMatchObject({
        sourceId: 'static',
        isProvisional: true,
      })
      live.failFetch = false
      advanceHours(25)
      const { provenance } = await resolveDay(resolver)
      expect(provenance.sourceId).toBe('fake')
      expect(provenance).not.toHaveProperty('isProvisional')
    })
  })

  describe('a source that cannot be probed, in a new process', () => {
    const seed = async (store: IntensityStore, omit: string[] = []) => {
      const { resolver } = createResolver({
        sources: [new FakeSource({ granularities: ['hour'], omit })],
        store,
      })
      await resolveDay(resolver)
    }

    it('gives a final result from a store that holds the whole period', async () => {
      const store = new InMemoryIntensityStore()
      await seed(store)
      const down = new FakeSource({ failCapabilities: true })
      const { resolver } = createResolver({
        sources: [down, staticSource()],
        store,
      })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({ sourceId: 'fake', qualityTier: 'B' })
      expect(provenance).not.toHaveProperty('isProvisional')
    })

    it('gives a provisional result from a store that holds part of it', async () => {
      const store = new InMemoryIntensityStore()
      await seed(store, ['2026-03-10T15:00:00.000Z'])
      const down = new FakeSource({ failCapabilities: true })
      const { resolver } = createResolver({
        sources: [down, staticSource()],
        store,
      })
      const { provenance } = await resolveDay(resolver)
      expect(provenance).toMatchObject({
        sourceId: 'fake',
        qualityTier: 'C',
        isProvisional: true,
      })
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
