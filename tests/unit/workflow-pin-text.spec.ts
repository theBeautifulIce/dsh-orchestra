import { expect, it } from 'vitest'
import { workflowPinFromText } from '../../src/service/chat-native.ts'

it.each([
  ['用流程「日报核对」第2版生成报告', '日报核对', '2'],
  ['使用已发布的流程“Daily Review” 第 2 版生成报告', 'Daily Review', '2'],
  ['用流程「日报核对」，第3版生成报告', '日报核对', '3'],
  ['用流程 "Daily Review" v2 生成报告', 'Daily Review', '2'],
  ['用流程 review，第2版生成报告', 'review', '2'],
])('显式流程引用保留完整名称和版本 %s', (text, name, version) => {
  expect(workflowPinFromText(text)).toEqual({ name, version })
})
it('非法显式版本产生输入错误', () => {
  expect(() => workflowPinFromText('用流程「日报核对」第0版生成报告')).toThrow('有效的已发布版本')
  expect(workflowPinFromText('用流程「日报核对」生成报告')).toEqual({ name: '日报核对' })
})
