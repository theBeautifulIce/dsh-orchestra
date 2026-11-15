// 测试用单调时钟：取消/扫描写时限都必须带锚点，测试不再走墙钟兜底（S3 round12 P2-3）
import { ScriptedClock } from '../../src/core/clock.ts'

export const TEST_CLOCK = new ScriptedClock('boot_test', {
  wallClockMs: Date.parse('2026-11-13T03:00:00.000Z'),
  monotonicNs: 0,
})
