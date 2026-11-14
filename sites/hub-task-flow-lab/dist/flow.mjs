/** Project-native explainer. All actions are delegated by the host application. */
export function renderFlow() {
  return `
  <section class="flow-page" aria-labelledby="flow-title">
    <header class="flow-header">
      <div>
        <div class="flow-eyebrow">从信息到行动</div>
        <h1 id="flow-title">任务，最终是为了推进一件事。</h1>
        <p class="flow-intro">把分散的依据放在一起，把真正要做的事留在同一个任务里。Hub 帮你判断、推进和回顾，而不是多维护一份清单。</p>
      </div>
      <a class="flow-download" href="./task-flow.svg" download="hub-task-flow.svg">下载流程图 <span aria-hidden="true">↗</span></a>
    </header>

    <div class="flow-principles" aria-label="三个核心约定">
      <div><span class="flow-principle-index">01</span><strong>资料不自动变成任务</strong><p>新线索先判断；已经明确的任务直接使用。</p></div>
      <div><span class="flow-principle-index">02</span><strong>同一件事，只留一个任务</strong><p>资料、行动池、助手和日志都引用同一 ID。</p></div>
      <div><span class="flow-principle-index">03</span><strong>有结果，也有真实状态</strong><p>生成、完成和同步是三件不同的事。</p></div>
    </div>

    <div class="flow-layout">
      <figure class="flow-diagram">
        <a href="./task-flow.svg" target="_blank" rel="noopener" aria-label="在新标签页按原尺寸查看 Hub 任务流程图"><img src="./task-flow.svg" width="1000" height="1290" alt="Hub 任务流程：已有或明确新建任务直接进入；材料经待整理选择关联已有、确认新建或只留资料；现在分别显示硬截止、今日计划和可选行动池；执行或等待恢复后提交模拟完成，成功进入日志，失败重试或取消，结果未知先核对。" /></a>
        <figcaption>点击图查看原尺寸。滴答回写、AI 输出和来源确认均为交互演示，不会访问你的真实账户。</figcaption>
      </figure>

      <div class="flow-mobile" aria-label="任务流程文字版">
        <ol class="flow-mobile-steps">
          <li><strong>先分清：任务，还是线索？</strong><p>已有滴答任务、自己明确新建的任务直接进入。Craft、飞书、AI 中的新线索进入「待整理」，不会自动增加任务。</p></li>
          <li><strong>线索有三种去向</strong><p>关联或更新已有任务；确认新建任务；只保留为资料、稍后处理或忽略。</p></li>
          <li><strong>在一个任务上继续推进</strong><p>任务主档默认在滴答。关联材料只是依据，不复制任务；加入行动池也不改变原来的项目清单。</p></li>
          <li><strong>选择现在做什么</strong><p>硬截止承诺、今日计划与可选行动池分开显示；只有行动池限制最多 5 项，不会隐藏到期或计划任务。打开任务后，查看目的、下一步、依据和完成标准。</p></li>
          <li><strong>执行，或记录等待条件</strong><p>AI 可以准备核对清单和结果草稿。等待时写清等谁、等什么、何时回看；条件满足后恢复原任务，不自动完成。</p></li>
          <li><strong>完成后核对同步结果</strong><p>普通任务一键完成，交付型任务先核对结果。待确认或结果未知时先核对，不盲目重试；失败可重试同一操作，或先取消本次完成，再继续编辑。</p></li>
          <li><strong>结果进入日志与回顾</strong><p>本原型模拟来源确认成功后记录完成时间。重新打开会恢复原任务，并保留完成和重开的历史。</p></li>
        </ol>
      </div>

      <aside class="flow-guide" aria-labelledby="flow-scenario-title">
        <div class="flow-guide-heading"><span class="flow-example-label">贯穿示例</span><h2 id="flow-scenario-title">一份新图纸，如何变成结果？</h2></div>
        <ol class="flow-scenario">
          <li><span>收到变更</span><p>飞书里出现新版图纸通知。这是一条依据，不是又一条任务。</p><button type="button" data-action="flow-open" data-target="triage">去待整理 <span aria-hidden="true">→</span></button></li>
          <li><span>关联原任务</span><p>关联「核对固定点并反馈」。任务数量不增加，新图纸进入关联资料。</p></li>
          <li><span>开始推进</span><p>加入行动池，请助手整理新旧版本的核对清单。清单先作为草稿。</p><button type="button" data-action="flow-open" data-target="now">去现在 <span aria-hidden="true">→</span></button></li>
          <li><span>等待条件</span><p>还缺 DRE 的版本确认？记录等待原因，回复后继续同一个任务。</p><button type="button" data-action="flow-open" data-target="waiting">去等待 <span aria-hidden="true">→</span></button></li>
          <li><span>完成与回顾</span><p>核对完成，保留反馈结果。模拟同步确认后，日志中能回到原任务。</p><button type="button" data-action="flow-open" data-target="journal">去日志 <span aria-hidden="true">→</span></button></li>
        </ol>
        <div class="flow-boundary"><strong>四个容易混淆的地方</strong><ul><li>「加入行动池」不是复制任务。</li><li>「AI 已生成」不等于任务已完成。</li><li>「洞察已处理」不更改任务状态。</li><li>「同步失败」不能显示为来源已完成。</li></ul></div>
      </aside>
    </div>

    <footer class="flow-footer"><strong>这一版你可以重点看：</strong><span>要做什么是否更清楚？资料是否找得到？等待有没有下文？完成后是否留下了结果？</span></footer>
  </section>`;
}
