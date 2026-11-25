import { it } from 'vitest'
import { supervisorCases } from '../fixtures/task-supervisor-cases.ts'
for (const [name, run] of supervisorCases) it(name, run)
