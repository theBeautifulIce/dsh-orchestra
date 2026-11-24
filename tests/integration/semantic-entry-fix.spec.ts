import {expect,it} from 'vitest'
import {decideAutoRoute} from '../../src/service/semantic-admission.ts'
it('verifies grounded routing and preserves a whole-task deferral',()=>{
 expect(decideAutoRoute('请生成报告。先不要执行这项任务。',{clauses:[{target:'task',act:'perform',quote:'请生成报告'}]})).toBe('conversation')
 expect(decideAutoRoute('请生成报告',{clauses:[{target:'task',act:'perform',quote:'删除原文件'}]})).toBe('clarify')
 expect(decideAutoRoute('请生成报告先不要执行这项任务不要修改原文件', {clauses:[{target:'task',act:'perform',quote:'请生成报告'}]})).toBe('conversation')
 expect(decideAutoRoute('请生成报告，不要修改原文件',{clauses:[{target:'task',act:'perform',quote:'请生成报告'},{target:'material',act:'restrict',quote:'不要修改原文件'}]})).toBe('task')
})
