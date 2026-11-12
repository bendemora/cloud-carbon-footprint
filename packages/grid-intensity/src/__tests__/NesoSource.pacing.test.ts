/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * NESO applies a rate limit and publishes no figure for it (spike section
 * 7.3). The source therefore sends its requests one at a time and a second
 * apart, whichever call they belong to. The bodies here are generated in
 * the recorded shape; what the source reads from them is tested in
 * NesoSource.test.ts.
 */

import { NESO_MIN_REQUEST_INTERVAL_MS, NesoSource } from '../sources/NesoSource'
import {
  NESO_API,
  NesoApiMock,
  jsonResponse,
  mockNesoApi,
} from './fixtures/nesoApi'

const utc = (iso: string) => new Date(iso)
const DAY_MS = 24 * 3600 * 1000
const START = utc('2026-10-01T00:00:00.000Z')
const dayFrom = (days: number) => new Date(START.getTime() + days * DAY_MS)

describe('NesoSource: the spacing of its requests', () => {
  let api: NesoApiMock
  /** The source's clock. Waiting moves it on, as a real wait would. */
  let clockMs: number
  let waits: number[]

  const pacedSource = (minRequestIntervalMs?: number) =>
    new NesoSource({
      fetch: api.fetch,
      now: () => new Date(clockMs),
      sleep: async (milliseconds) => {
        waits.push(milliseconds)
        clockMs += milliseconds
      },
      ...(minRequestIntervalMs === undefined ? {} : { minRequestIntervalMs }),
    })

  const fetchDay = (source: NesoSource, day: number) =>
    source.fetch('national', dayFrom(day), dayFrom(day + 1), 'hour')

  beforeEach(() => {
    api = mockNesoApi()
    api.generate(() => 100)
    clockMs = utc('2026-11-12T12:00:00.000Z').getTime()
    waits = []
  })

  afterEach(() => {
    api.assertNoUnknownRequests()
  })

  it('is a second by default', () => {
    expect(NESO_MIN_REQUEST_INTERVAL_MS).toBe(1000)
  })

  it('sends the first request at once', async () => {
    await fetchDay(pacedSource(), 0)
    expect(waits).toEqual([])
  })

  it('waits a second between the requests of a range that is split', async () => {
    // 31 days: three requests.
    await pacedSource().fetch('national', START, dayFrom(31), 'hour')
    expect(api.urls()).toHaveLength(3)
    expect(waits).toEqual([1000, 1000])
  })

  it('waits between the requests of separate calls too', async () => {
    const source = pacedSource()
    api.respondTo(`${NESO_API}/intensity`, () => jsonResponse({ data: [] }))
    await fetchDay(source, 0)
    await fetchDay(source, 1)
    await expect(source.probe()).resolves.toEqual({
      reachable: true,
      authenticated: true,
    })
    expect(waits).toEqual([1000, 1000])
  })

  it('waits only for what is left of the interval', async () => {
    const source = pacedSource()
    await fetchDay(source, 0)
    clockMs += 400
    await fetchDay(source, 1)
    expect(waits).toEqual([600])
  })

  it('does not wait when the last request went out longer ago than the interval', async () => {
    const source = pacedSource()
    await fetchDay(source, 0)
    clockMs += 1000
    await fetchDay(source, 1)
    clockMs += 5000
    await fetchDay(source, 2)
    expect(waits).toEqual([])
  })

  it('sends the requests of calls made at the same time one after another', async () => {
    const source = pacedSource()
    const results = await Promise.all([
      fetchDay(source, 0),
      fetchDay(source, 1),
      fetchDay(source, 2),
    ])
    expect(results.map((points) => points.length)).toEqual([24, 24, 24])
    expect(api.mostInFlight()).toBe(1)
    expect(api.urls()).toEqual([
      `${NESO_API}/intensity/2026-10-01T00:00Z/2026-10-02T00:00Z`,
      `${NESO_API}/intensity/2026-10-02T00:00Z/2026-10-03T00:00Z`,
      `${NESO_API}/intensity/2026-10-03T00:00Z/2026-10-04T00:00Z`,
    ])
    expect(waits).toEqual([1000, 1000])
  })

  it('does not let a failed request hold up the next one', async () => {
    const source = pacedSource()
    api.respondTo(
      `${NESO_API}/intensity/2026-10-01T00:00Z/2026-10-02T00:00Z`,
      () => {
        throw new TypeError('fetch failed')
      },
    )
    await expect(fetchDay(source, 0)).rejects.toThrow('fetch failed')
    await expect(fetchDay(source, 1)).resolves.toHaveLength(24)
    expect(waits).toEqual([1000])
  })

  it('takes another interval, and none at all when it is 0', async () => {
    const slow = pacedSource(2500)
    await fetchDay(slow, 0)
    await fetchDay(slow, 1)
    expect(waits).toEqual([2500])

    waits = []
    const unpaced = pacedSource(0)
    await fetchDay(unpaced, 0)
    await fetchDay(unpaced, 1)
    expect(waits).toEqual([])
  })

  it('waits on a timer when it is given no other way to wait', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    try {
      const source = new NesoSource({
        fetch: api.fetch,
        now: () => new Date(clockMs),
      })
      await fetchDay(source, 0)
      let done = false
      const second = fetchDay(source, 1).then((points) => {
        done = true
        return points
      })
      // Let the request reach its wait, then see that it is still waiting.
      await new Promise((resolve) => setImmediate(resolve))
      expect(done).toBe(false)
      expect(api.urls()).toHaveLength(1)

      await jest.advanceTimersByTimeAsync(999)
      expect(api.urls()).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toHaveLength(24)
      expect(api.urls()).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
