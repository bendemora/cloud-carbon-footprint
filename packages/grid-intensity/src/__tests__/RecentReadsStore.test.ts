/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import {
  MAX_READS_PER_SERIES,
  RECENT_READ_MS,
  RecentReadsStore,
} from '../stores/RecentReadsStore'
import { IntensityPoint, IntensityStore } from '../types'

const utc = (iso: string) => new Date(iso)
const HOUR_MS = 3600 * 1000
const DAY_START = utc('2026-03-10T00:00:00.000Z')
const DAY_END = utc('2026-03-11T00:00:00.000Z')
const NEXT_DAY_END = utc('2026-03-12T00:00:00.000Z')

const hour = (
  index: number,
  overrides: Partial<IntensityPoint> = {},
): IntensityPoint => ({
  zoneId: 'GB',
  periodStart: new Date(DAY_START.getTime() + index * HOUR_MS),
  periodEnd: new Date(DAY_START.getTime() + (index + 1) * HOUR_MS),
  granularity: 'hour',
  gCO2ePerKWh: 100 + index,
  basis: 'location-consumption',
  factorType: 'direct',
  isEstimated: false,
  sourceId: 'neso',
  retrievedAt: utc('2026-03-12T09:00:00.000Z'),
  ...overrides,
})

describe('RecentReadsStore', () => {
  let inner: InMemoryIntensityStore
  let get: jest.SpyInstance
  let nowMs: number
  let store: RecentReadsStore

  const readDay = (zoneId = 'GB') =>
    store.get('neso', zoneId, DAY_START, DAY_END, 'hour')

  beforeEach(async () => {
    inner = new InMemoryIntensityStore()
    await inner.put([hour(0), hour(1)])
    get = jest.spyOn(inner, 'get')
    nowMs = Date.parse('2026-03-12T10:00:00.000Z')
    store = new RecentReadsStore(inner, () => nowMs)
  })

  it('reads the store once for a series and period, for a minute', async () => {
    expect(RECENT_READ_MS).toBe(60_000)
    const first = await readDay()
    nowMs += RECENT_READ_MS - 1
    const second = await readDay()

    expect(first).toEqual([hour(0), hour(1)])
    expect(second).toEqual(first)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('neso', 'GB', DAY_START, DAY_END, 'hour')

    nowMs += 1
    await readDay()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('gives each caller a list of its own', async () => {
    const first = await readDay()
    first.pop()
    await expect(readDay()).resolves.toHaveLength(2)
  })

  it('reads another period, zone, source or granularity for itself', async () => {
    await readDay()
    await store.get('neso', 'GB', DAY_END, NEXT_DAY_END, 'hour')
    await readDay('IE')
    await store.get('other', 'GB', DAY_START, DAY_END, 'hour')
    await store.get('neso', 'GB', DAY_START, DAY_END, 'day')
    expect(get).toHaveBeenCalledTimes(5)
  })

  it('shares one read between calls made at the same time', async () => {
    const results = await Promise.all([readDay(), readDay(), readDay()])
    expect(get).toHaveBeenCalledTimes(1)
    expect(results[0]).not.toBe(results[1])
    expect(results[2]).toEqual([hour(0), hour(1)])
  })

  it('sees at once what is written through it, and only forgets that series', async () => {
    await readDay()
    await readDay('IE')

    await store.put([hour(2)])

    await expect(readDay()).resolves.toEqual([hour(0), hour(1), hour(2)])
    await readDay('IE')
    // Great Britain twice, Ireland once.
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not remember a read that was under way when a write came', async () => {
    let release: (points: IntensityPoint[]) => void = () => undefined
    get.mockImplementationOnce(
      () =>
        new Promise<IntensityPoint[]>((resolve) => {
          release = resolve
        }),
    )
    const before = readDay()
    await store.put([hour(2)])
    release([hour(0), hour(1)])

    // The read that began before the write gets what it read.
    await expect(before).resolves.toHaveLength(2)
    // A read after the write is a new one.
    await expect(readDay()).resolves.toHaveLength(3)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('forgets the series of a source when its points are purged', async () => {
    await inner.put([hour(0, { sourceId: 'other' })])
    await readDay()
    await store.get('other', 'GB', DAY_START, DAY_END, 'hour')

    await expect(
      store.purge('neso', utc('2026-03-13T00:00:00.000Z')),
    ).resolves.toBe(2)

    await expect(readDay()).resolves.toEqual([])
    await store.get('other', 'GB', DAY_START, DAY_END, 'hour')
    // neso twice, the other source once.
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not remember a read that failed, and hands the failure on', async () => {
    get.mockRejectedValueOnce(new Error('disk unreadable'))
    await expect(readDay()).rejects.toThrow('disk unreadable')
    await expect(readDay()).resolves.toHaveLength(2)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('gives the failure to every call that shared the read', async () => {
    get.mockRejectedValueOnce(new Error('disk unreadable'))
    const results = await Promise.allSettled([readDay(), readDay()])
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    await expect(readDay()).resolves.toHaveLength(2)
  })

  it('forgets the series also when the write or the purge fails', async () => {
    await readDay()
    jest.spyOn(inner, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.put([hour(2)])).rejects.toThrow('disk full')
    await readDay()
    expect(get).toHaveBeenCalledTimes(2)

    jest.spyOn(inner, 'purge').mockRejectedValueOnce(new Error('disk gone'))
    await expect(store.purge('neso', DAY_START)).rejects.toThrow('disk gone')
    await readDay()
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('drops the reads that have run out when it makes a new one', async () => {
    const remembered = store as unknown as {
      reads: Map<string, Map<string, unknown>>
    }
    await readDay()
    await store.get('neso', 'GB', DAY_END, NEXT_DAY_END, 'hour')
    expect(remembered.reads.get('neso|GB|hour')?.size).toBe(2)

    nowMs += RECENT_READ_MS
    await store.get('neso', 'GB', DAY_START, NEXT_DAY_END, 'hour')
    expect(remembered.reads.get('neso|GB|hour')?.size).toBe(1)
  })

  it('starts again when it holds the most periods it remembers for a series', async () => {
    for (let index = 0; index < MAX_READS_PER_SERIES; index++)
      await store.get(
        'neso',
        'GB',
        new Date(DAY_START.getTime() + index * HOUR_MS),
        new Date(DAY_START.getTime() + (index + 1) * HOUR_MS),
        'hour',
      )
    expect(get).toHaveBeenCalledTimes(MAX_READS_PER_SERIES)
    // The first period is still remembered ...
    await store.get(
      'neso',
      'GB',
      DAY_START,
      new Date(DAY_START.getTime() + HOUR_MS),
      'hour',
    )
    expect(get).toHaveBeenCalledTimes(MAX_READS_PER_SERIES)
    // ... until one more period than the limit has been read.
    await readDay()
    await store.get(
      'neso',
      'GB',
      DAY_START,
      new Date(DAY_START.getTime() + HOUR_MS),
      'hour',
    )
    expect(get).toHaveBeenCalledTimes(MAX_READS_PER_SERIES + 2)
  })

  it('closes the store behind it, and is closed without harm when that store cannot be', async () => {
    await expect(store.close()).resolves.toBeUndefined()

    const close = jest.fn().mockResolvedValue(undefined)
    const closable: IntensityStore & { close: () => Promise<void> } =
      Object.assign(new InMemoryIntensityStore(), { close })
    await new RecentReadsStore(closable).close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses the system clock when it is given none', async () => {
    const byDefault = new RecentReadsStore(inner)
    await byDefault.get('neso', 'GB', DAY_START, DAY_END, 'hour')
    await byDefault.get('neso', 'GB', DAY_START, DAY_END, 'hour')
    expect(get).toHaveBeenCalledTimes(1)
  })
})
