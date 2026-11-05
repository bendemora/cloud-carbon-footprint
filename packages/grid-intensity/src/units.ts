/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Results are rounded to 12 significant figures. That removes binary
 * floating-point noise (0.000415755 * 1e6 is 415.75499999999994 in IEEE 754)
 * and, because the CCF factor tables carry at most 10 significant figures,
 * converting a table value to grams and back returns the identical number.
 */
const SIGNIFICANT_FIGURES = 12

const round = (value: number): number =>
  Number(value.toPrecision(SIGNIFICANT_FIGURES))

/** tCO2e/kWh (what the CCF estimators use) to gCO2e/kWh (what sources publish). */
export const tonnesToGrams = (tonnesPerKWh: number): number =>
  round(tonnesPerKWh * 1e6)

/** gCO2e/kWh to tCO2e/kWh. */
export const gramsToTonnes = (gramsPerKWh: number): number =>
  round(gramsPerKWh / 1e6)
