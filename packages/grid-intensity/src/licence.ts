/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { LicenceDeclaration, LicenceId } from './types'

const ACKNOWLEDGEMENT_REQUIRED: readonly LicenceId[] = [
  'commercial',
  'non-commercial',
  'custom',
]

/**
 * Sources under these licences stay inert until the operator lists them in
 * GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS (section 6.3 of the design).
 */
export const requiresAcknowledgement = (licence: LicenceDeclaration): boolean =>
  ACKNOWLEDGEMENT_REQUIRED.includes(licence.id)
