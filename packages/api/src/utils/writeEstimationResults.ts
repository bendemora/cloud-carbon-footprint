/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Writable } from 'stream'
import { EstimationResult } from '@cloud-carbon-footprint/common'

/** Write to the destination once about this many characters are buffered. */
export const JSON_CHUNK_CHARS = 1024 * 1024

const CLOSED_MESSAGE =
  'The destination closed before the estimates were written'

/**
 * Writes plain estimation results to a stream as the same JSON text that
 * JSON.stringify(results) returns, without ever holding that text in one
 * string. Each service estimate is serialised on its own, so neither the
 * whole response nor one period's estimates has to fit within the longest
 * string Node can hold (about 512 MiB). Waits for the destination to drain
 * when it applies backpressure, and rejects if it closes first.
 */
export const writeEstimationResults = async (
  out: Writable,
  results: EstimationResult[],
  chunkChars = JSON_CHUNK_CHARS,
): Promise<void> => {
  let buffered = ''

  const flush = async () => {
    if (out.destroyed) throw new Error(CLOSED_MESSAGE)
    const chunk = buffered
    buffered = ''
    if (!out.write(chunk)) await drained(out)
  }

  const write = async (text: string) => {
    buffered += text
    if (buffered.length >= chunkChars) await flush()
  }

  await write('[')
  for (let i = 0; i < results.length; i++) {
    if (i > 0) await write(',')
    await writeEstimationResult(results[i], write)
  }
  await write(']')
  await flush()
}

const writeEstimationResult = async (
  result: EstimationResult,
  write: (text: string) => Promise<void>,
) => {
  if (!Array.isArray(result.serviceEstimates)) {
    await write(JSON.stringify(result))
    return
  }
  // Same key order and omissions as JSON.stringify: own enumerable keys in
  // order, leaving out values that serialise to nothing (undefined).
  await write('{')
  let separator = ''
  for (const [key, value] of Object.entries(result)) {
    if (key === 'serviceEstimates') {
      await write(`${separator}${JSON.stringify(key)}:[`)
      for (let i = 0; i < result.serviceEstimates.length; i++) {
        if (i > 0) await write(',')
        await write(JSON.stringify(result.serviceEstimates[i]) ?? 'null')
      }
      await write(']')
    } else {
      const json = JSON.stringify(value)
      if (json === undefined) continue
      await write(`${separator}${JSON.stringify(key)}:${json}`)
    }
    separator = ','
  }
  await write('}')
}

const drained = (out: Writable) =>
  new Promise<void>((resolve, reject) => {
    const stopListening = () => {
      out.off('drain', onDrain)
      out.off('close', onClose)
      out.off('error', onError)
    }
    const onDrain = () => {
      stopListening()
      resolve()
    }
    const onClose = () => {
      stopListening()
      reject(new Error(CLOSED_MESSAGE))
    }
    const onError = (err: Error) => {
      stopListening()
      reject(err)
    }
    out.on('drain', onDrain)
    out.on('close', onClose)
    out.on('error', onError)
  })
