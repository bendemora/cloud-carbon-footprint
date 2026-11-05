/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { missingPeriods, timeWeightedMean } from '../coverage'
import { periodsCovering } from '../granularity'
import { Granularity, IntensityPoint } from '../types'

const utc = (iso: string) => new Date(iso)

const point = (
  start: string,
  end: string,
  gCO2ePerKWh: number,
  granularity: Granularity = 'hour',
): IntensityPoint => ({
  zoneId: 'GB',
  periodStart: utc(start),
  periodEnd: utc(end),
  granularity,
  gCO2ePerKWh,
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  sourceId: 'test',
  retrievedAt: utc('2026-11-05T00:00:00.000Z'),
})

describe('timeWeightedMean', () => {
  it('weights each point by its overlap with the range', () => {
    const result = timeWeightedMean(
      [
        point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 100),
        point('2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z', 300),
      ],
      utc('2026-01-01T00:30:00.000Z'),
      utc('2026-01-01T02:00:00.000Z'),
    )
    // 30 minutes at 100 and 60 minutes at 300
    expect(result).toEqual({ gCO2ePerKWh: 700 / 3, coverage: 1 })
  })

  it('returns the value itself for one point that spans the range', () => {
    expect(
      timeWeightedMean(
        [point('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 250)],
        utc('2026-03-01T00:00:00.000Z'),
        utc('2026-03-02T00:00:00.000Z'),
      ),
    ).toEqual({ gCO2ePerKWh: 250, coverage: 1 })
  })

  it('reports partial coverage and averages over the covered part only', () => {
    expect(
      timeWeightedMean(
        [point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 100)],
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T04:00:00.000Z'),
      ),
    ).toEqual({ gCO2ePerKWh: 100, coverage: 0.25 })
  })

  it('ignores points outside the range', () => {
    expect(
      timeWeightedMean(
        [
          point('2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z', 900),
          point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 100),
        ],
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
      ),
    ).toEqual({ gCO2ePerKWh: 100, coverage: 1 })
  })

  it('returns null when no point overlaps the range', () => {
    expect(
      timeWeightedMean(
        [point('2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z', 100)],
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
      ),
    ).toBeNull()
  })

  it('returns null for an empty range', () => {
    const t = utc('2026-01-01T00:00:00.000Z')
    expect(
      timeWeightedMean(
        [point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 1)],
        t,
        t,
      ),
    ).toBeNull()
  })
})

describe('missingPeriods', () => {
  const expected = periodsCovering(
    utc('2026-01-01T00:00:00.000Z'),
    utc('2026-01-01T05:00:00.000Z'),
    'hour',
  )

  it('merges consecutive periods without a point into ranges', () => {
    const present = [
      point('2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z', 1),
      point('2026-01-01T04:00:00.000Z', '2026-01-01T05:00:00.000Z', 1),
    ]
    expect(
      missingPeriods(expected, present).map((p) => [
        p.start.toISOString(),
        p.end.toISOString(),
      ]),
    ).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'],
      ['2026-01-01T02:00:00.000Z', '2026-01-01T04:00:00.000Z'],
    ])
  })

  it('returns nothing when every period has a point', () => {
    const present = expected.map((p) =>
      point(p.start.toISOString(), p.end.toISOString(), 1),
    )
    expect(missingPeriods(expected, present)).toEqual([])
  })

  it('returns one range when nothing is present', () => {
    expect(missingPeriods(expected, [])).toEqual([
      { start: expected[0].start, end: expected[4].end },
    ])
  })
})
