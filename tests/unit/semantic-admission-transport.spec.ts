import { it } from 'vitest'
import { semanticTransportCases } from '../fixtures/semantic-admission-transport-cases.ts'
for (const test of semanticTransportCases) it(test.name, test.run)
