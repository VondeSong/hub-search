import { ArrowUpRight, BookOpen, FileText, Moon, Sun } from 'lucide-react';
import type { HubItem } from './data';

export type PreviewTheme = 'current' | 'craft';
export const previewSample: HubItem = {
  id: 'preview-theme-sample', title: '给知识留一处，安静的阅读空间', kind: 'note', source: 'craft',
  space: 'Hub / 预览主题 / 对比样本', group: '今天', date: '2026-11-11', dateLabel: '今天',
  tags: ['设计', '阅读'], excerpt: '一篇固定的排版样本：长文、标题、引用、提示、列表、表格、代码与图片。',
  sections: [
    { type: 'p', text: '打开一篇笔记，先看到内容，再慢慢进入思考。舒适的阅读空间，需要清楚的层级，也需要恰到好处的停顿。文字、图片和引用各自有位置，视线便能自然地向下走。' },
    { type: 'p', text: '这是一份为预览主题制作的固定示例。切换上方的“当前”和“Craft 风格”，比较同一篇文档的字号、留白与内容块；文字本身保持一致。' },
    { type: 'h2', text: '把注意力交还给内容' },
    { type: 'quote', text: '好的排版，是在需要停顿的地方留白，在需要理解的地方建立联系。' },
    { type: 'p', text: '读一段较长的中文时，行距决定了每一行的呼吸，段距则帮助我们区分完整的想法。标题上方多一点空间，让新话题有明确的开始；下方稍近一些，让标题与它所解释的内容保持联系。' },
    { type: 'list', items: ['标题：用大小与字重表达层级，减少额外装饰。', '正文：保留舒适的行宽，让宽屏与窄窗都有稳定的阅读节奏。', '引用：与作者正文区分，同时保持完整的上下文。'] },
    { type: 'callout', text: '阅读提示：这里演示的是 Craft 风格的展示主题。所有内容均为原型样本，没有连接真实笔记或同步服务。' },
    { type: 'h2', text: '一段内容，也有不同的形状' },
    { type: 'p', text: '清单适合并列的想法，表格适合比较，代码适合保留精确的表达。每一种形式都应帮助阅读。下面的样本用于观察这些内容在两种主题中的表现。' },
    { type: 'checklist', items: ['标题与正文能一眼区分', '窄窗口下的长内容仍然完整', '浅色和深色下都能清楚阅读'] },
  ],
};

export function PreviewThemeControls({ value, onChange, dark, onToggleDark, onSample }: {
  value: PreviewTheme; onChange: (theme: PreviewTheme) => void; dark: boolean; onToggleDark: () => void; onSample: () => void;
}) {
  return <div className="preview-theme-bar" aria-label="预览主题对比">
    <div className="preview-theme-choice"><span>预览样式</span><div role="group" aria-label="预览样式">
      <button type="button" aria-pressed={value === 'current'} onClick={() => onChange('current')}>当前</button>
      <button type="button" aria-pressed={value === 'craft'} onClick={() => onChange('craft')}>Craft 风格</button>
    </div></div>
    <div className="preview-theme-tools"><button type="button" onClick={onSample}><BookOpen size={14} aria-hidden="true"/><span>对比样本</span></button>
      <button type="button" aria-label={dark ? '切换浅色外观' : '切换深色外观'} title={dark ? '切换浅色外观' : '切换深色外观'} onClick={onToggleDark}>{dark ? <Sun size={16}/> : <Moon size={16}/>}</button>
    </div>
  </div>;
}

export function PreviewSampleBlocks({ onOpenRelated }: { onOpenRelated: () => void }) {
  return <>
    <h3>表格，适合放在一起比较</h3>
    <div className="preview-sample-table" role="region" aria-label="排版要素对照表，可横向滚动" tabIndex={0}><table><caption>阅读中的三个层次 · 排版示例</caption><thead><tr><th scope="col">内容</th><th scope="col">阅读目的</th><th scope="col">关注的细节</th></tr></thead><tbody>
      <tr><th scope="row">标题与正文</th><td>找到主题，连续阅读</td><td>层级、行宽与段落间距</td></tr>
      <tr><th scope="row">引用与提示</th><td>区分观点，保留上下文</td><td>缩进、底色与文字对比</td></tr>
      <tr><th scope="row">代码与附件</th><td>保留表达，继续查阅</td><td>横向滚动与来源入口</td></tr>
    </tbody></table></div>
    <h3>代码，保留原本的表达</h3>
    <div className="preview-sample-code"><span>JSON · 展示示例</span><pre tabIndex={0} aria-label="JSON 代码示例，可横向滚动"><code>{'{\n  "previewTheme": "craft",\n  "document": "同一篇内容，两种阅读方式",\n  "note": "这是一段较长的示例文字，用于检查窄窗口中的代码横向滚动是否正常。"\n}'}</code></pre></div>
    <h3>图片，让文字有一个具体的参照</h3>
    <figure className="preview-sample-figure"><img src="/hub-workspace-preview.jpg" width={1440} height={1000} alt="Hub 工作台既有原型截图，包含资料列表和右侧阅读面板" loading="lazy"/><figcaption>Hub 既有原型截图 · 用于观察图片边界与图注</figcaption></figure>
    <h3>沿着链接，继续读下去</h3>
    <button type="button" className="preview-sample-page" onClick={onOpenRelated}><FileText size={22} aria-hidden="true"/><span><strong>UI 设计示例</strong><small>打开原型中的相关文档</small></span><ArrowUpRight size={16} aria-hidden="true"/></button>
    <p>阅读可以暂时停在这里。下次打开时，清楚的结构会帮助我们重新找到思路。</p>
  </>;
}
