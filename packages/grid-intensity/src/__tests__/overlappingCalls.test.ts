/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Calls of the resolver overlap: the provider packages resolve the rows of
 * several accounts, and every recommendation, at once, and the API serves
 * overlapping requests. A call that has something to fetch waits in the line
 * of its zone of the source, so that it finds what the call before it
 * fetched or met. These tests cover that line.
 */

import {
  GridIntensityResolver,
  GridIntensityResolverOptions,
} from '../GridIntensityResolver'
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { FakeSource, FetchCall } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const HOUR_MS = 3600 * 1000
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
/** The ISO week that holds the day: Monday 9 to Monday 16 March 2026. */
const WEEK_START = utc('2026-03-09T00:00:00.000Z')
const WEEK_END = utc('2026-03-16T00:00:00.000Z')
const CALLS = 10

const createResolver = (
  options: Partial<GridIntensityResolverOptions> & {
    sources: GridIntensityResolverOptions['sources']
  },
) => {
  const logger = { warn: jest.fn() }
  const resolver = new GridIntensityResolver({
    logger,
    now: () => utc('2026-11-05T12:00:00.000Z'),
    ...options,
  })
  return { resolver, logger }
}

/** The outcome of each of a number of calls made at once. */
const atOnce = <T>(calls: (() => Promise<T>)[]) =>
  Promise.allSettled(calls.map((call) => call()))

const sameCalls = <T>(call: () => Promise<T>) =>
  atOnce(Array.from({ length: CALLS }, () => call))

const hoursOf = (calls: FetchCall[]): number =>
  calls.reduce(
    (hours, call) =>
      hours + (Date.parse(call.end) - Date.parse(call.start)) / HOUR_MS,
    0,
  )

describe('resolver calls made at the same time', () => {
  it('send one request for a period they all need', async () => {
    const live = new FakeSource({ granularities: ['hour'] })
    const { resolver } = createResolver({ sources: [live] })

    const results = await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    expect(live.fetchCalls).toEqual([
      {
        zoneId: 'GB',
        start: DAY_START.toISOString(),
        end: DAY_END.toISOString(),
        granularity: 'hour',
      },
    ])
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'fulfilled',
        value: { gCO2ePerKWh: 100, provenance: { qualityTier: 'B' } },
      })
      expect(result.status === 'fulfilled' && result.value.points).toHaveLength(
        24,
      )
    }
  })

  it('send one request for a period with a gap, and none for the gap', async () => {
    const live = new FakeSource({
      granularities: ['hour'],
      omit: ['2026-03-10T05:00:00.000Z'],
    })
    const { resolver } = createResolver({ sources: [live] })

    const results = await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    expect(live.fetchCalls).toHaveLength(1)
    for (const result of results)
      expect(result).toMatchObject({
        status: 'fulfilled',
        value: { provenance: { qualityTier: 'C', isProvisional: true } },
      })
  })

  it('send one request for a period the source has nothing for', async () => {
    const live = new FakeSource({
      granularities: ['day'],
      omit: [DAY_START.toISOString()],
    })
    const { resolver } = createResolver({ sources: [live] })

    const results = await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    expect(live.fetchCalls).toHaveLength(1)
    for (const result of results)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { name: 'NoIntensityAvailableError', mayImprove: true },
      })
  })

  it('meet one failure with one request and one warning', async () => {
    const live = new FakeSource({ granularities: ['hour'], failFetch: true })
    const { resolver, logger } = createResolver({ sources: [live] })

    const results = await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    expect(live.fetchCalls).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    for (const result of results)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { name: 'NoIntensityAvailableError' },
      })
  })

  it('meet one failure with one request when they ask for different periods and granularities', async () => {
    const live = new FakeSource({
      granularities: ['hour', 'day'],
      failFetch: true,
    })
    const { resolver, logger } = createResolver({ sources: [live] })
    const DAY_MS = 24 * HOUR_MS

    const results = await atOnce([
      // Nine days by the day, and an hour of each by the hour.
      ...Array.from({ length: 9 }, (_unused, day) => () => {
        const start = new Date(DAY_START.getTime() + day * DAY_MS)
        return resolver.resolve(
          'AWS',
          'eu-west-2',
          start,
          new Date(start.getTime() + DAY_MS),
        )
      }),
      ...Array.from({ length: 9 }, (_unused, day) => () => {
        const start = new Date(DAY_START.getTime() + day * DAY_MS)
        return resolver.resolve(
          'AWS',
          'eu-west-2',
          start,
          new Date(start.getTime() + HOUR_MS),
        )
      }),
    ])

    expect(live.fetchCalls).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    for (const result of results)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { name: 'NoIntensityAvailableError' },
      })
  })

  it('fetch no hour twice when their periods overlap', async () => {
    const live = new FakeSource({ granularities: ['hour'] })
    const { resolver } = createResolver({ sources: [live] })

    const [day, week] = await Promise.all([
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
      resolver.resolve('AWS', 'eu-west-2', WEEK_START, WEEK_END),
    ])

    expect(day.points).toHaveLength(24)
    expect(week.points).toHaveLength(7 * 24)
    // The week has 168 hours, and the day is 24 of them.
    expect(hoursOf(live.fetchCalls)).toBe(7 * 24)
  })

  it('are not held up when they have nothing to fetch', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const live = new FakeSource({
      granularities: ['hour'],
      // The fetch for the next day gets no answer until the test says so.
      beforeAnswer: (call) =>
        call.start === DAY_END.toISOString() ? held : undefined,
    })
    const { resolver } = createResolver({ sources: [live] })
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

    const nextDay = resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_END,
      utc('2026-03-12T00:00:00.000Z'),
    )
    // The day that is stored is served while the other fetch is under way.
    const stored = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )
    expect(stored.points).toHaveLength(24)
    expect(live.fetchCalls).toHaveLength(2)

    release()
    await expect(nextDay).resolves.toMatchObject({ gCO2ePerKWh: 100 })
  })

  it('wait only for calls of their own zone', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const live = new FakeSource({
      granularities: ['hour'],
      zones: { 'eu-west-2': 'GB', 'eu-west-1': 'IE' },
      beforeAnswer: (call) => (call.zoneId === 'GB' ? held : undefined),
    })
    const { resolver } = createResolver({ sources: [live] })

    const london = resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    const dublin = await resolver.resolve(
      'AWS',
      'eu-west-1',
      DAY_START,
      DAY_END,
    )
    expect(dublin.provenance.zoneId).toBe('IE')

    release()
    await expect(london).resolves.toMatchObject({
      provenance: { zoneId: 'GB' },
    })
  })

  it('look at the store again when their turn comes, also when it could not be read before', async () => {
    const store = new InMemoryIntensityStore()
    const get = jest.spyOn(store, 'get')
    const live = new FakeSource({ granularities: ['hour'] })
    const { resolver } = createResolver({ sources: [live], store })

    await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    // Every call reads once; the nine that waited read again.
    expect(get).toHaveBeenCalledTimes(CALLS + (CALLS - 1))
    expect(live.fetchCalls).toHaveLength(1)
  })

  it('go on in line after a call whose turn threw', async () => {
    const live = new FakeSource({ granularities: ['hour'], failFetch: true })
    const warn = jest.fn().mockImplementationOnce(() => {
      throw new Error('the logger is broken')
    })
    const { resolver } = createResolver({ sources: [live], logger: { warn } })

    const results = await atOnce([
      () => resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
      () => resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
      () => resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    ])

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'the logger is broken' },
    })
    // The failure was recorded before the logger threw, so the others meet
    // it and make no request of their own.
    for (const result of results.slice(1))
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { name: 'NoIntensityAvailableError' },
      })
    expect(live.fetchCalls).toHaveLength(1)
  })

  it('do not queue for a source whose values come from code', async () => {
    // Nothing of such a source is stored, so waiting would gain nothing.
    const fromCode = Object.assign(new FakeSource({ granularities: ['day'] }), {
      persist: false,
    })
    const { resolver } = createResolver({ sources: [fromCode] })

    const results = await sameCalls(() =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END),
    )

    expect(fromCode.fetchCalls).toHaveLength(CALLS)
    for (const result of results)
      expect(result).toMatchObject({ status: 'fulfilled' })
  })
})
