/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { gramsToTonnes, tonnesToGrams } from '../units'

describe('unit conversion between tCO2e/kWh and gCO2e/kWh', () => {
  it('converts tonnes to grams without binary floating-point noise', () => {
    // 0.000415755 * 1e6 is 415.75499999999994 in IEEE 754 doubles
    expect(tonnesToGrams(0.000415755)).toBe(415.755)
  })

  it('round-trips the static factor tables exactly', () => {
    for (const factor of [
      0.000376128319, 0.000365127796, 0.000008, 0.0009006,
    ]) {
      expect(gramsToTonnes(tonnesToGrams(factor))).toBe(factor)
    }
  })

  it('converts grams to tonnes', () => {
    expect(gramsToTonnes(250)).toBe(0.00025)
  })
})
