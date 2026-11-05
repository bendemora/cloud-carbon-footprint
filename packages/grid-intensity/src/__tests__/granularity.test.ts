/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  addPeriod,
  isAtLeastAsFine,
  periodsCovering,
  startOfPeriod,
} from '../granularity'

const utc = (iso: string) => new Date(iso)

describe('isAtLeastAsFine', () => {
  it.each([
    ['hour', 'hour', true],
    ['hour', 'day', true],
    ['day', 'month', true],
    ['month', 'year', true],
    ['day', 'hour', false],
    ['year', 'month', false],
  ] as const)('%s is at least as fine as %s: %s', (a, b, expected) => {
    expect(isAtLeastAsFine(a, b)).toBe(expected)
  })
})

describe('startOfPeriod', () => {
  const instant = utc('2026-03-15T13:45:12.345Z')

  it.each([
    ['hour', '2026-03-15T13:00:00.000Z'],
    ['day', '2026-03-15T00:00:00.000Z'],
    ['month', '2026-03-01T00:00:00.000Z'],
    ['year', '2026-01-01T00:00:00.000Z'],
  ] as const)('truncates to the start of the %s in UTC', (g, expected) => {
    expect(startOfPeriod(instant, g).toISOString()).toBe(expected)
  })

  it('does not modify its argument', () => {
    const date = utc('2026-03-15T13:45:12.345Z')
    startOfPeriod(date, 'year')
    expect(date.toISOString()).toBe('2026-03-15T13:45:12.345Z')
  })
})

describe('addPeriod', () => {
  it.each([
    ['hour', '2026-12-31T23:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['day', '2028-02-28T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['month', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['month', '2026-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z'],
    ['year', '2028-02-29T00:00:00.000Z', '2029-02-28T00:00:00.000Z'],
  ] as const)('adds one %s to %s', (g, from, expected) => {
    expect(addPeriod(utc(from), g).toISOString()).toBe(expected)
  })
})

describe('periodsCovering', () => {
  it('returns the aligned periods that overlap [start, end)', () => {
    const periods = periodsCovering(
      utc('2025-12-31T22:30:00.000Z'),
      utc('2026-01-01T01:00:00.000Z'),
      'hour',
    )
    expect(
      periods.map((p) => [p.start.toISOString(), p.end.toISOString()]),
    ).toEqual([
      ['2025-12-31T22:00:00.000Z', '2025-12-31T23:00:00.000Z'],
      ['2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'],
    ])
  })

  it('returns calendar years for a range spanning a year boundary', () => {
    const periods = periodsCovering(
      utc('2025-12-01T00:00:00.000Z'),
      utc('2026-02-01T00:00:00.000Z'),
      'year',
    )
    expect(periods.map((p) => p.start.toISOString())).toEqual([
      '2025-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
  })

  it('returns no periods for an empty or inverted range', () => {
    const t = utc('2026-01-01T00:00:00.000Z')
    expect(periodsCovering(t, t, 'day')).toEqual([])
    expect(periodsCovering(t, utc('2025-01-01T00:00:00.000Z'), 'day')).toEqual(
      [],
    )
  })

  it('returns no periods for an empty range that starts mid-period', () => {
    const t = utc('2026-03-15T13:45:00.000Z')
    expect(periodsCovering(t, t, 'year')).toEqual([])
  })
})
