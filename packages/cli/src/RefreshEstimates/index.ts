/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/* istanbul ignore file */
import refreshEstimates from './refreshEstimates'

refreshEstimates()
  .then(({ output, exitCode }) => {
    console.log(output)
    process.exitCode = exitCode
  })
  .catch((error) => {
    console.error(`Something went wrong: ${error.message}`)
    process.exitCode = 1
  })
