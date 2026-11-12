/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { Granularity, IntensityPoint } from '../types'

const utc = (iso: string) => new Date(iso)

const point = (
  overrides: Partial<IntensityPoint> & { periodStart: Date; periodEnd: Date },
): IntensityPoint => ({
  zoneId: 'GB',
  granularity: 'hour' as Granularity,
  gCO2ePerKWh: 100,
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  sourceId: 'entsoe',
  retrievedAt: utc('2026-11-01T00:00:00.000Z'),
  ...overrides,
})

const h = (hour: number) =>
  utc(`2026-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`)

describe('InMemoryIntensityStore', () => {
  it('returns stored points that overlap the range, in period order', async () => {
    const store = new InMemoryIntensityStore()
    await store.put([
      point({ periodStart: h(2), periodEnd: h(3) }),
      point({ periodStart: h(0), periodEnd: h(1) }),
      point({ periodStart: h(1), periodEnd: h(2) }),
    ])
    const points = await store.get('entsoe', 'GB', h(1), h(3), 'hour')
    expect(points.map((p) => p.periodStart)).toEqual([h(1), h(2)])
  })

  it('keeps sources, zones and granularities apart', async () => {
    const store = new InMemoryIntensityStore()
    await store.put([
      point({ periodStart: h(0), periodEnd: h(1) }),
      point({ periodStart: h(0), periodEnd: h(1), zoneId: 'FR' }),
      point({ periodStart: h(0), periodEnd: h(1), sourceId: 'neso' }),
      point({
        periodStart: utc('2026-01-01T00:00:00.000Z'),
        periodEnd: utc('2026-01-02T00:00:00.000Z'),
        granularity: 'day',
      }),
    ])
    const points = await store.get('entsoe', 'GB', h(0), h(1), 'hour')
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      zoneId: 'GB',
      sourceId: 'entsoe',
      granularity: 'hour',
    })
  })

  it('replaces a point stored again for the same period', async () => {
    const store = new InMemoryIntensityStore()
    await store.put([
      point({ periodStart: h(0), periodEnd: h(1), gCO2ePerKWh: 100 }),
    ])
    await store.put([
      point({ periodStart: h(0), periodEnd: h(1), gCO2ePerKWh: 120 }),
    ])
    const points = await store.get('entsoe', 'GB', h(0), h(1), 'hour')
    expect(points.map((p) => p.gCO2ePerKWh)).toEqual([120])
  })

  it('returns an empty list for an unknown series', async () => {
    await expect(
      new InMemoryIntensityStore().get('x', 'y', h(0), h(1), 'hour'),
    ).resolves.toEqual([])
  })

  it('purges points of a source retrieved before the cut-off and counts them', async () => {
    const store = new InMemoryIntensityStore()
    await store.put([
      point({
        periodStart: h(0),
        periodEnd: h(1),
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
      point({
        periodStart: h(1),
        periodEnd: h(2),
        retrievedAt: utc('2026-11-04T00:00:00.000Z'),
      }),
      point({
        periodStart: h(0),
        periodEnd: h(1),
        sourceId: 'neso',
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
    ])
    await expect(
      store.purge('entsoe', utc('2026-11-01T00:00:00.000Z')),
    ).resolves.toBe(1)
    const remaining = await store.get('entsoe', 'GB', h(0), h(2), 'hour')
    expect(remaining.map((p) => p.periodStart)).toEqual([h(1)])
    await expect(
      store.get('neso', 'GB', h(0), h(1), 'hour'),
    ).resolves.toHaveLength(1)
  })
})
