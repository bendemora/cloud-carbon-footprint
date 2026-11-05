/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { requiresAcknowledgement } from '../licence'
import { LicenceId } from '../types'

describe('requiresAcknowledgement', () => {
  it.each([
    ['commercial', true],
    ['non-commercial', true],
    ['custom', true],
    ['public-domain', false],
    ['CC-BY-4.0', false],
    ['open-attribution', false],
  ] as [LicenceId, boolean][])('%s: %s', (id, expected) => {
    expect(
      requiresAcknowledgement({
        id,
        redistributable: false,
        retention: 'unlimited',
      }),
    ).toBe(expected)
  })
})
