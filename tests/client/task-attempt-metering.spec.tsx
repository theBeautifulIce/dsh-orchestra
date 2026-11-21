// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { TaskRunSteps } from '../../src/client/panel/task-run-steps.tsx'
import { nodeRunView, renderPanel } from './harness.ts'

it('displays reported zeros, partial counters, and missing legacy metering separately', async () => {
  const assignment = {
    model_ref: 'fixture/meter', complexity: 'routine', reason: 'fixture', state: 'confirmed',
    usage: { provider: 'fixture', model: 'meter', observed_request_headers: 1 },
  } as const
  const node = nodeRunView({ node_type: 'agent', attempt: 2, model_assignment: assignment })
  const view = await renderPanel(<TaskRunSteps nodes={[node]} />)
  try {
    expect(view.text()).toContain('第 2 次尝试')
    expect(view.text()).toContain('本次尝试模型用量（Token） · 不可用')
    expect(view.text()).toContain('上下文压缩 · 不可用')
    await view.rerender(<TaskRunSteps nodes={[{ ...node, model_assignment: { ...assignment, usage: { ...assignment.usage,
      metering: {
        tokens: { uncached_input_tokens: 57, output_tokens: 0, cache_read_tokens: 15, cache_write_tokens: null },
        context_compactions: { summaries: 0, tool_result_prunes: 1 },
      },
    } } }]} />)
    expect(view.text()).toContain('输入（未缓存）57 · 输出0 · 缓存读取15 · 缓存写入不可用')
    expect(view.text()).toContain('摘要 0 次 · 工具结果裁剪 1 次')
    await view.rerender(<TaskRunSteps nodes={[{ ...node, model_assignment: undefined }]} />)
    expect(view.text()).toContain('本次尝试模型用量（Token） · 不可用')
  } finally { view.unmount() }
})
