/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The resolver is called once for every billing row, and nothing is stored
 * for a period a source has no point for. These tests cover the memory that
 * stops such a period being asked for again within the capability TTL.
 */

import {
  GridIntensityResolver,
  GridIntensityResolverOptions,
} from '../GridIntensityResolver'
import { IntensityResolver } from '../types'
import { FakeSource } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const NEXT_DAY_END = utc('2026-03-12T00:00:00.000Z')
const GAP = '2026-03-10T05:00:00.000Z'

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
  const advanceHours = (hours: number) => {
    now = new Date(now.getTime() + hours * 3600 * 1000)
  }
  return { resolver, logger, advanceHours }
}

const resolveDay = (resolver: IntensityResolver) =>
  resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

describe('a period a source has no point for', () => {
  it('is asked for once, however often the usage period is resolved', async () => {
    const live = new FakeSource({ granularities: ['hour'], omit: [GAP] })
    const { resolver } = createResolver({ sources: [live] })

    const first = await resolveDay(resolver)
    const second = await resolveDay(resolver)
    const third = await resolveDay(resolver)

    expect(live.fetchCalls).toEqual([
      {
        zoneId: 'GB',
        start: DAY_START.toISOString(),
        end: DAY_END.toISOString(),
        granularity: 'hour',
      },
    ])
    // The answer is the same each time: 23 of 24 hours, estimated.
    for (const result of [first, second, third]) {
      expect(result.points).toHaveLength(23)
      expect(result.provenance).toMatchObject({
        isEstimated: true,
        qualityTier: 'C',
        isProvisional: true,
      })
    }
  })

  it('is asked for again after the capability TTL, and used when the source then has it', async () => {
    const live = new FakeSource({ granularities: ['hour'], omit: [GAP] })
    const { resolver, advanceHours } = createResolver({ sources: [live] })
    await resolveDay(resolver)

    advanceHours(23)
    await resolveDay(resolver)
    expect(live.fetchCalls).toHaveLength(1)

    live.omit = []
    advanceHours(2)
    const result = await resolveDay(resolver)
    expect(live.fetchCalls[1]).toEqual({
      zoneId: 'GB',
      start: GAP,
      end: '2026-03-10T06:00:00.000Z',
      granularity: 'hour',
    })
    expect(result.points).toHaveLength(24)
    expect(result.provenance).toMatchObject({
      isEstimated: false,
      qualityTier: 'B',
    })
    expect(result.provenance).not.toHaveProperty('isProvisional')
  })

  it('is asked for again after the TTL even when the source still has nothing', async () => {
    const live = new FakeSource({ granularities: ['hour'], omit: [GAP] })
    const { resolver, advanceHours } = createResolver({
      sources: [live],
      capabilityTtlHours: 1,
    })
    await resolveDay(resolver)
    advanceHours(2)
    await resolveDay(resolver)
    await resolveDay(resolver)
    expect(live.fetchCalls.map((call) => call.start)).toEqual([
      DAY_START.toISOString(),
      GAP,
    ])
  })

  it('does not stop other periods of the same zone being asked for', async () => {
    const live = new FakeSource({ granularities: ['hour'], omit: [GAP] })
    const { resolver } = createResolver({ sources: [live] })
    await resolveDay(resolver)
    const nextDay = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_END,
      NEXT_DAY_END,
    )
    expect(live.fetchCalls.map((call) => call.start)).toEqual([
      DAY_START.toISOString(),
      DAY_END.toISOString(),
    ])
    expect(nextDay.points).toHaveLength(24)
  })

  it('counts a point the resolver drops as nothing, and does not ask again', async () => {
    // 2,000 gCO2e/kWh is outside the bounds for fetched data.
    const live = new FakeSource({
      granularities: ['hour'],
      value: (start) => (start.toISOString() === GAP ? 2000 : 100),
    })
    const { resolver, logger } = createResolver({ sources: [live] })
    const first = await resolveDay(resolver)
    await resolveDay(resolver)
    expect(first.points).toHaveLength(23)
    expect(live.fetchCalls).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('is remembered for each granularity on its own', async () => {
    // Asked by the day for a day of usage and by the hour for an hour of it.
    const live = new FakeSource({
      granularities: ['hour', 'day'],
      omit: [DAY_START.toISOString()],
    })
    const { resolver } = createResolver({ sources: [live] })
    await expect(resolveDay(resolver)).rejects.toMatchObject({
      name: 'NoIntensityAvailableError',
    })
    const hour = await resolver.resolve(
      'AWS',
      'eu-west-2',
      utc('2026-03-10T13:00:00.000Z'),
      utc('2026-03-10T14:00:00.000Z'),
    )
    expect(hour.points).toHaveLength(1)
    await expect(resolveDay(resolver)).rejects.toMatchObject({
      name: 'NoIntensityAvailableError',
    })
    expect(live.fetchCalls.map((call) => call.granularity)).toEqual([
      'day',
      'hour',
    ])
  })
})
