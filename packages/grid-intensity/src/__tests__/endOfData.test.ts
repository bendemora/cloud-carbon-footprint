/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The end of a live source's data moves with the clock. The resolver keeps
 * a source's capability for the TTL (24 hours by default), which is too long
 * for that: these tests cover the earlier question it asks when a usage
 * period runs past the end of data it knows of.
 */

import {
  GridIntensityResolver,
  GridIntensityResolverOptions,
} from '../GridIntensityResolver'
import { FakeSource, FakeSourceOptions } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const NOON = utc('2026-03-10T12:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const DAY_BEFORE = utc('2026-03-09T00:00:00.000Z')

const createResolver = (
  options: Partial<GridIntensityResolverOptions> & {
    sources: GridIntensityResolverOptions['sources']
  },
) => {
  let now = utc('2026-11-05T12:00:00.000Z')
  const logger = { warn: jest.fn() }
  const resolver = new GridIntensityResolver({
    logger,
    now: () => now,
    ...options,
  })
  const advanceMinutes = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60 * 1000)
  }
  return { resolver, advanceMinutes, logger }
}

describe("the end of a source's data", () => {
  it('is asked for again after an hour when a usage period runs past it', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    const resolveDay = () =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

    const first = await resolveDay()
    expect(first.points).toHaveLength(12)
    expect(first.provenance).toMatchObject({
      qualityTier: 'C',
      isProvisional: true,
    })

    // The source has the whole day now, but the answer is half an hour old.
    live.latest = DAY_END
    advanceMinutes(30)
    expect((await resolveDay()).points).toHaveLength(12)
    expect(live.capabilityCalls).toBe(1)

    advanceMinutes(30)
    const later = await resolveDay()
    expect(live.capabilityCalls).toBe(2)
    expect(later.points).toHaveLength(24)
    expect(later.provenance).toMatchObject({ qualityTier: 'B' })
    expect(later.provenance).not.toHaveProperty('isProvisional')
    // Only the afternoon was fetched the second time.
    expect(live.fetchCalls[1]).toEqual({
      zoneId: 'GB',
      start: NOON.toISOString(),
      end: DAY_END.toISOString(),
      granularity: 'hour',
    })
  })

  it('is not asked for again for a period that ends before it', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    await resolver.resolve('AWS', 'eu-west-2', DAY_BEFORE, DAY_START)
    advanceMinutes(180)
    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_BEFORE,
      DAY_START,
    )
    expect(result.points).toHaveLength(24)
    expect(live.capabilityCalls).toBe(1)
  })

  it('is asked for once an hour at most, however often the period is resolved', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    const resolveDay = () =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    await resolveDay()
    for (let minutes = 0; minutes < 150; minutes += 10) {
      advanceMinutes(10)
      await resolveDay()
    }
    // At the start, then after 60 and after 120 minutes.
    expect(live.capabilityCalls).toBe(3)
  })

  it("is not asked for again while the zone's fetches are stopped by a failure", async () => {
    const live = new FakeSource({
      granularities: ['hour'],
      latest: NOON,
      failFetch: true,
    })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    const resolveDay = () =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    await expect(resolveDay()).rejects.toMatchObject({
      name: 'NoIntensityAvailableError',
    })
    advanceMinutes(180)
    await expect(resolveDay()).rejects.toMatchObject({
      name: 'NoIntensityAvailableError',
    })
    expect(live.capabilityCalls).toBe(1)
    expect(live.fetchCalls).toHaveLength(1)
  })

  it('keeps the answer in hand when the question goes wrong, and asks again an hour later', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes, logger } = createResolver({
      sources: [live],
    })
    const resolveDay = () =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    await resolveDay()

    // The source has the whole day now, but cannot say so.
    live.latest = DAY_END
    live.failCapabilities = true
    advanceMinutes(61)
    const during = await resolveDay()
    expect(live.capabilityCalls).toBe(2)
    // The zone is not stopped: the day is served as before.
    expect(during.points).toHaveLength(12)
    expect(during.provenance).toMatchObject({ sourceId: 'fake' })
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source fake could not say how far its data for zone GB reaches now: capability probe failed. Its earlier answer is used.',
      ],
    ])

    // Not asked again within the hour, and not warned about again.
    advanceMinutes(30)
    await resolveDay()
    expect(live.capabilityCalls).toBe(2)

    live.failCapabilities = false
    advanceMinutes(31)
    const after = await resolveDay()
    expect(live.capabilityCalls).toBe(3)
    expect(after.points).toHaveLength(24)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the answer in hand when the question is answered with nothing', async () => {
    const options: FakeSourceOptions = { granularities: ['hour'] }
    const live = new FakeSource(options)
    live.latest = NOON
    const { resolver, advanceMinutes, logger } = createResolver({
      sources: [live],
    })
    const resolveDay = () =>
      resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    await resolveDay()

    options.unavailable = true
    advanceMinutes(61)
    const during = await resolveDay()
    expect(live.capabilityCalls).toBe(2)
    expect(during.points).toHaveLength(12)
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source fake could not say how far its data for zone GB reaches now: it gave no answer for the zone. Its earlier answer is used.',
      ],
    ])

    options.unavailable = false
    live.latest = DAY_END
    advanceMinutes(61)
    await expect(resolveDay()).resolves.toMatchObject({
      provenance: { qualityTier: 'B' },
    })
  })

  it('stops the zone as before when the question at the end of the TTL fails', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes, logger } = createResolver({
      sources: [live],
    })
    await resolver.resolve('AWS', 'eu-west-2', DAY_BEFORE, DAY_START)

    live.failCapabilities = true
    advanceMinutes(24 * 60 + 1)
    // The stored day is still served, from the answer the source gave last.
    const stored = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_BEFORE,
      DAY_START,
    )
    expect(stored.points).toHaveLength(24)
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source fake capability probe failed for zone GB: capability probe failed. Skipping it for 24 hours.',
      ],
    ])
  })

  it('is an answer for a whole TTL again when it was asked for early', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    live.latest = DAY_END
    advanceMinutes(61)
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    expect(live.capabilityCalls).toBe(2)

    // 24 hours and a minute after the first question, and 23 hours after
    // the second: the second answer still stands.
    advanceMinutes(23 * 60)
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    expect(live.capabilityCalls).toBe(2)
    advanceMinutes(61)
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    expect(live.capabilityCalls).toBe(3)
  })

  it('is kept for the whole TTL when the source gives none', async () => {
    const live = new FakeSource({ granularities: ['hour'] })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    advanceMinutes(23 * 60)
    await resolver.resolve('AWS', 'eu-west-2', DAY_END, utc('2026-03-12'))
    expect(live.capabilityCalls).toBe(1)
    advanceMinutes(120)
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)
    expect(live.capabilityCalls).toBe(2)
  })

  it('is asked for again by the capability report, whose windows end now', async () => {
    const live = new FakeSource({ granularities: ['hour'], latest: NOON })
    const { resolver, advanceMinutes } = createResolver({ sources: [live] })
    await resolver.sourceViews('AWS', 'eu-west-2')
    await resolver.sourceViews('AWS', 'eu-west-2')
    expect(live.capabilityCalls).toBe(1)
    live.latest = DAY_END
    advanceMinutes(61)
    const [view] = await resolver.sourceViews('AWS', 'eu-west-2')
    expect(live.capabilityCalls).toBe(2)
    expect(view.capability?.latest).toEqual(DAY_END)
  })
})
