/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/* istanbul ignore file */
import gridIntensityDoctor from './gridIntensityDoctor'

gridIntensityDoctor()
  .then(console.log)
  .catch((error) => {
    console.error(`Something went wrong: ${error.message}`)
    process.exitCode = 1
  })
