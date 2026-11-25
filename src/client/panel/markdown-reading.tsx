import MarkdownIt from 'markdown-it'
import { createElement, useMemo, useState, type ReactNode } from 'react'

const parser = new MarkdownIt({ html:false,linkify:false,typographer:false,maxNesting:24 })
const blocks = new Set(['p','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6',
  'em','strong','s','table','thead','tbody','tr','th','td'])
function renderText(text: string): ReactNode {
  if (text.length > 32768) return <pre>{text}</pre>
  let budget = 4096
  function render(tokens: ReturnType<typeof parser.parse>): ReactNode[] {
    type Frame = {tag: string; children: ReactNode[]}
    const stack: Frame[] = [{tag:'',children:[]}]
    for (const token of tokens) {
      if (--budget < 0) throw new Error('document limit')
      const frame = stack[stack.length-1]!
      const key = budget
      if (token.nesting === 1) {stack.push({tag:token.tag,children:[]});continue}
      if (token.nesting === -1) {
        if (stack.length === 1 || token.tag !== frame.tag) throw new Error('invalid nesting')
        stack.pop()
        const parent = stack[stack.length-1]!
        if (blocks.has(frame.tag)) parent.children.push(createElement(frame.tag,{key},frame.children))
        else parent.children.push(...frame.children)
        continue
      }
      switch (token.type) {
        case 'inline': frame.children.push(...render(token.children ?? []));break
        case 'fence':case 'code_block': frame.children.push(<pre key={key}><code>{token.content}</code></pre>);break
        case 'code_inline': frame.children.push(<code key={key}>{token.content}</code>);break
        case 'hardbreak': frame.children.push(<br key={key}/>);break
        case 'softbreak': frame.children.push('\n');break
        case 'hr': frame.children.push(<hr key={key}/>);break
        case 'image': frame.children.push(token.content || '图片');break
        default: frame.children.push(token.content)
      }
    }
    if (stack.length !== 1) throw new Error('incomplete document')
    return stack[0]!.children
  }
  try { return render(parser.parse(text,{})) } catch { return <pre>{text}</pre> }
}
export function MarkdownReading({text}:{text:string}) {
  const [raw,setRaw]=useState(false)
  const content=useMemo(()=>renderText(text),[text])
  return <section aria-label="成果内容">
    <button className="ops-button" type="button" aria-pressed={raw} onClick={()=>setRaw(v=>!v)}>
      {raw?'切换为阅读视图':'显示原文'}
    </button>
    <div style={{overflowX:'auto',overflowWrap:'anywhere'}}>{raw?<pre>{text}</pre>:content}</div>
  </section>
}
