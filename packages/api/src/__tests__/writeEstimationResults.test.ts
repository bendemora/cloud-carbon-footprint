/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { Writable } from 'stream'
import { EstimationResult, GroupBy } from '@cloud-carbon-footprint/common'
import { writeEstimationResults } from '../utils/writeEstimationResults'

const row = {
  cloudProvider: 'AWS',
  kilowattHours: 0.0123456789012,
  co2e: 0.00000412345678901,
  cost: 1.23456789,
  usesAverageCPUConstant: false,
  accountId: '123456789012',
  accountName: 'account "quoted" é',
  serviceName: 'AmazonEC2',
  region: 'us-east-1',
  tags: { team: 'carbon' },
  provenance: {
    sourceId: 'static',
    zoneId: 'aws:us-east-1',
    granularity: 'year',
    basis: 'location-production',
    factorType: 'direct',
    isEstimated: false,
    licenceId: 'open-attribution',
    qualityTier: 'D',
    gCO2ePerKWh: 379.069,
    modelVersion: 'unversioned',
    calibrationVersion: undefined,
  },
}

const results = [
  {
    timestamp: new Date('2020-07-12'),
    serviceEstimates: [row, { ...row, region: 'eu-west-1' }, undefined],
    periodStartDate: new Date('2020-07-12'),
    periodEndDate: undefined,
    groupBy: GroupBy.day,
  },
  {
    groupBy: GroupBy.day,
    timestamp: new Date('2020-07-13'),
    serviceEstimates: [],
    periodStartDate: new Date('2020-07-13'),
    periodEndDate: new Date('2020-07-13T23:59:59.000Z'),
  },
  {
    timestamp: new Date('2020-07-14'),
    serviceEstimates: undefined,
    groupBy: GroupBy.day,
  },
] as unknown as EstimationResult[]

const collector = (write: Writable['_write'], highWaterMark = 16) => {
  const chunks: string[] = []
  const out = new Writable({
    highWaterMark,
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString())
      write.call(this, chunk, encoding, callback)
    },
  })
  return { out, text: () => chunks.join(''), chunks }
}

describe('writeEstimationResults', () => {
  it('writes the same text as JSON.stringify', async () => {
    const { out, text } = collector((_chunk, _encoding, callback) => callback())

    await writeEstimationResults(out, results)

    expect(text()).toEqual(JSON.stringify(results))
  })

  it('writes an empty array', async () => {
    const { out, text } = collector((_chunk, _encoding, callback) => callback())

    await writeEstimationResults(out, [])

    expect(text()).toEqual('[]')
  })

  it('writes in chunks of about the given size, waiting for the destination to drain', async () => {
    const { out, text, chunks } = collector(
      (_chunk, _encoding, callback) => setImmediate(callback),
      1,
    )

    await writeEstimationResults(out, results, 100)

    expect(text()).toEqual(JSON.stringify(results))
    expect(chunks.length).toBeGreaterThan(2)
    chunks
      .slice(0, -1)
      .forEach((chunk) => expect(chunk.length).toBeGreaterThanOrEqual(100))
  })

  it('stops when the destination closes before everything is written', async () => {
    const { out } = collector(() => {
      // never finishes a write, so the destination never drains
    }, 1)

    const writing = writeEstimationResults(out, results, 10)
    setImmediate(() => out.destroy())

    await expect(writing).rejects.toThrow(
      'The destination closed before the estimates were written',
    )
  })

  it('stops when the destination fails before everything is written', async () => {
    const { out } = collector(() => {
      // never finishes a write, so the destination never drains
    }, 1)
    const destinationError = new Error('socket hang up')

    const writing = writeEstimationResults(out, results, 10)
    setImmediate(() => out.destroy(destinationError))

    await expect(writing).rejects.toThrow(destinationError)
  })

  it('does not write to a destination that is already closed', async () => {
    const { out, chunks } = collector((_chunk, _encoding, callback) =>
      callback(),
    )
    out.destroy()

    await expect(writeEstimationResults(out, results, 10)).rejects.toThrow(
      'The destination closed before the estimates were written',
    )
    expect(chunks).toEqual([])
  })
})
