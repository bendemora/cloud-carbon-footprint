/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * A source reads a long range in several requests. When a later one fails,
 * its fetch() throws a PartialFetchError with the points of the requests
 * that were answered, and the resolver keeps them.
 */

import { GridIntensityResolver } from '../GridIntensityResolver'
import { PartialFetchError, partialPointsOf } from '../PartialFetchError'
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { IntensityPoint } from '../types'
import { FakeSource } from './fixtures/FakeSource'

const utc = (iso: string) => new Date(iso)
const HOUR_MS = 3600 * 1000
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const NOW = utc('2026-11-05T12:00:00.000Z')

const hour = (index: number, gCO2ePerKWh = 100): IntensityPoint => ({
  zoneId: 'GB',
  periodStart: new Date(DAY_START.getTime() + index * HOUR_MS),
  periodEnd: new Date(DAY_START.getTime() + (index + 1) * HOUR_MS),
  granularity: 'hour',
  gCO2ePerKWh,
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  sourceId: 'fake',
  retrievedAt: NOW,
})

const firstTenHours = Array.from({ length: 10 }, (_unused, index) =>
  hour(index),
)

describe('PartialFetchError', () => {
  it('is an error with a name, the points and the cause', () => {
    const cause = new Error('HTTP 429')
    const error = new PartialFetchError(
      'request 2 of 3 failed',
      firstTenHours,
      {
        cause,
      },
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PartialFetchError')
    expect(error.message).toBe('request 2 of 3 failed')
    expect(error.points).toBe(firstTenHours)
    expect(error.cause).toBe(cause)
  })

  it.each([
    ['another error', new Error('HTTP 429')],
    ['an error that has points and another name', { points: firstTenHours }],
    [
      'an error with the name and no list of points',
      { name: 'PartialFetchError', points: 'none' },
    ],
    ['a string', 'HTTP 429'],
    ['null', null],
    ['undefined', undefined],
  ])('gives no points for %s', (_case, thrown) => {
    expect(partialPointsOf(thrown)).toEqual([])
  })

  it('is known by its name, so one from another copy of the package counts', () => {
    const foreign = Object.assign(new Error('request 2 of 3 failed'), {
      name: 'PartialFetchError',
      points: firstTenHours,
    })
    expect(partialPointsOf(foreign)).toBe(firstTenHours)
  })
})

describe('a fetch that fails part of the way through a range', () => {
  const failingAfter = (points: IntensityPoint[]) =>
    new FakeSource({
      granularities: ['hour'],
      beforeAnswer: () => {
        throw new PartialFetchError('request 2 of 3 failed: HTTP 429', points)
      },
    })

  const createResolver = (
    source: FakeSource,
    store = new InMemoryIntensityStore(),
  ) => {
    const logger = { warn: jest.fn() }
    const resolver = new GridIntensityResolver({
      sources: [source],
      store,
      logger,
      now: () => NOW,
    })
    return { resolver, logger, store }
  }

  it('keeps the points that were read: they are stored and the period is served from them', async () => {
    const { resolver, logger, store } = createResolver(
      failingAfter(firstTenHours),
    )

    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    expect(result.points).toHaveLength(10)
    expect(result.provenance).toMatchObject({
      sourceId: 'fake',
      isEstimated: true,
      qualityTier: 'C',
      isProvisional: true,
    })
    await expect(
      store.get('fake', 'GB', DAY_START, DAY_END, 'hour'),
    ).resolves.toHaveLength(10)
    // It is still a failed fetch: one warning, and the zone is stopped.
    expect(logger.warn.mock.calls).toEqual([
      [
        'Grid intensity source fake fetch failed for zone GB: request 2 of 3 failed: HTTP 429. Skipping it for 24 hours.',
      ],
    ])
  })

  it('leaves only the rest to ask for, in a later process on the same store', async () => {
    const { store } = createResolver(failingAfter(firstTenHours))
    await createResolver(failingAfter(firstTenHours), store).resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    const working = new FakeSource({ granularities: ['hour'] })
    const later = await createResolver(working, store).resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    expect(working.fetchCalls).toEqual([
      {
        zoneId: 'GB',
        start: '2026-03-10T10:00:00.000Z',
        end: DAY_END.toISOString(),
        granularity: 'hour',
      },
    ])
    expect(later.points).toHaveLength(24)
    expect(later.provenance).toMatchObject({ qualityTier: 'B' })
  })

  it('does not take the hours that were not read for hours the source does not have', async () => {
    const source = failingAfter(firstTenHours)
    const { resolver } = createResolver(source)
    await resolver.resolve('AWS', 'eu-west-2', DAY_START, DAY_END)

    const remembered = resolver as unknown as {
      emptyUntil: Map<string, number>
    }
    expect(remembered.emptyUntil.size).toBe(0)
  })

  it('checks the points it is handed as it checks any others', async () => {
    const { resolver, logger, store } = createResolver(
      failingAfter([
        hour(0),
        // Outside the bounds for fetched data.
        hour(1, 2000),
        // Of another zone.
        { ...hour(2), zoneId: 'IE' },
      ]),
    )

    const result = await resolver.resolve(
      'AWS',
      'eu-west-2',
      DAY_START,
      DAY_END,
    )

    expect(result.points).toHaveLength(1)
    await expect(
      store.get('fake', 'GB', DAY_START, DAY_END, 'hour'),
    ).resolves.toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })
})
