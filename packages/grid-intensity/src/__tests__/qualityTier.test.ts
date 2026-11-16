/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { deriveQualityTier } from '../qualityTier'

describe('deriveQualityTier', () => {
  const live = { sourceId: 'neso', isEstimated: false }

  it('is D for the static source whatever the granularities', () => {
    expect(
      deriveQualityTier({
        sourceId: 'static',
        isEstimated: false,
        intensityGranularity: 'hour',
        usageGranularity: 'hour',
      }),
    ).toBe('D')
  })

  it('is A for hourly intensity applied to hourly usage', () => {
    expect(
      deriveQualityTier({
        ...live,
        intensityGranularity: 'hour',
        usageGranularity: 'hour',
      }),
    ).toBe('A')
  })

  it.each([
    ['hour', 'day'],
    ['day', 'day'],
    ['hour', 'month'],
    ['day', 'hour'],
  ] as const)(
    'is B for %s intensity applied to %s usage',
    (intensityGranularity, usageGranularity) => {
      expect(
        deriveQualityTier({ ...live, intensityGranularity, usageGranularity }),
      ).toBe('B')
    },
  )

  it.each(['month', 'year'] as const)(
    'is C for %s intensity from a live source',
    (intensityGranularity) => {
      expect(
        deriveQualityTier({
          ...live,
          intensityGranularity,
          usageGranularity: 'day',
        }),
      ).toBe('C')
    },
  )

  it('is C when a live source marks the values as estimated', () => {
    expect(
      deriveQualityTier({
        sourceId: 'neso',
        isEstimated: true,
        intensityGranularity: 'hour',
        usageGranularity: 'hour',
      }),
    ).toBe('C')
  })
})
