'use strict';

// Interaction-only snapshot of the authenticated runtime catalog, 2026-11-16.
const agentDemoModels = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol', 'low'], ['gpt-6-astra', 'GPT-6 Astra', 'medium'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra', 'low'], ['gpt-6-sol', 'GPT-6 Sol', 'medium'],
  ['gpt-6-luna', 'GPT-6 Luna', 'medium'], ['gpt-5.6-sol', 'GPT-5.6 Sol', 'low'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 'medium'], ['gpt-5.6-luna', 'GPT-5.6 Luna', 'medium']
];
const agentDemoEfforts = {low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',ultra:'Ultra'};
function agentUiModelLabel(thread) {
  return agentDemoModels.find(item => item[0] === thread.uiModel)?.[1] || agentDemoModels[0][1];
}
function agentPreferenceSheet(thread, page = 'model') {
  if (!thread) return;
  const current = agentDemoModels.find(item => item[0] === thread.uiModel) || agentDemoModels[0];
  const effort = thread.uiEffort || current[2];
  const option = (label, detail, act, selected) => '<button type="button" class="agent-preference-option" data-act="' + esc(act) + '" aria-pressed="' + Boolean(selected) + '"><span><strong>' + esc(label) + '</strong>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>' + (selected ? ico('check',19) : '') + '</button>';
  let body = '';
  if (page === 'model') {
    body = '<div class="agent-preference-options">' + agentDemoModels.map((m,i) => option(m[1], i === 0 ? '执行端默认模型 · 示例目录' : '', 'agent-model-pick:' + thread.id + ':' + m[0], current[0] === m[0])).join('') + '</div>' +
      '<div class="agent-preference-links">' + row('推理强度', agentDemoEfforts[effort], 'spark', 'agent-effort:' + thread.id) + row('订阅用量', '查看额度周期', 'info', 'agent-usage:' + thread.id) + '</div>' +
      '<p class="settings-note">仅演示下一条消息的选择。目录取自执行端快照，网页未连接模型；正式客户端以实时目录为准。</p>';
  } else if (page === 'effort') {
    body = '<p class="settings-note">' + esc(current[1]) + ' · 用于下一条消息</p><div class="agent-preference-options">' +
      Object.entries(agentDemoEfforts).filter(([id]) => id !== 'ultra' || !current[0].endsWith('luna')).map(([id,label]) => option(label, id === current[2] ? '此模型的默认强度' : '', 'agent-effort-pick:' + thread.id + ':' + id, effort === id)).join('') + '</div>';
  } else if (page === 'skills') {
    body = '<label class="agent-skill-search">' + ico('search',18) + '<input id="agent-skill-search" placeholder="搜索技能" aria-label="搜索技能"></label><div class="agent-skill-list"><div class="agent-skill-row" data-skill-search="record-to-log 记录整理为日志"><button type="button" data-act="agent-skill-pick:' + thread.id + ':log" aria-label="添加技能 记录整理为日志"><span><strong>/record-to-log</strong><span>将零散叙述整理为精炼、时间可信、状态清楚的日志。</span><small>交互示例</small></span></button><button type="button" class="agent-skill-info" data-act="agent-skill-detail:' + thread.id + '" aria-label="查看技能 记录整理为日志 的详情">' + ico('info',19) + '</button></div><p id="agent-skill-empty" hidden>没有匹配的技能。</p></div><p class="settings-note">点技能名称添加到消息；右侧查看描述和参考文件。只演示选择，未执行技能。</p>';

  } else if (page === 'skill-detail') {
    const paths = ['references/formats.md','references/scenarios.md','references/storage.md','references/validation-cases.md'];
    body = plain('返回技能列表','agent-skills:' + thread.id,'back') + '<h3 class="agent-preference-heading">记录整理为日志</h3><p class="prose">将零散叙述、聊天或已有记录整理为精炼、时间可信、状态清楚的日志。添加到消息后再发送，不自动执行。</p><details><summary>配套文件 · 4</summary><p class="settings-note">默认加入 4 份配套文字；正文引用的文件需保留。</p><div class="agent-skill-files">' + paths.map((path,i) => '<label><input type="checkbox" data-agent-skill-file="' + thread.id + ':' + i + '" ' + ((thread.uiSkillPaths || [0,1,2,3]).includes(i) ? 'checked' : '') + '><span>' + esc(path.split('/').pop()) + '<small>references/</small></span></label>').join('') + '</div></details><div class="agent-skill-add"><p class="settings-note">示例方法，网页不会执行技能或发送文件。</p>' + btn('添加到消息','agent-skill-pick:' + thread.id + ':log','wide') + '</div>';

  } else {
    body = '<div class="agent-preference-options"><div class="agent-usage-line"><strong>ChatGPT 订阅</strong><span>原型未读取真实用量</span></div></div><p class="settings-note">7 天是每周额度的统计周期，10080 分钟不是已使用时长。正式客户端分别展示“本周已用”和“5 小时额度已用”，以执行端提供的周期和恢复时间为准。</p>';
  }
  sheet(({model:'选择模型',effort:'推理强度',skills:'技能','skill-detail':'/record-to-log',usage:'订阅用量'})[page], body);
}
function agentPreferenceAction(action, key, value) {
  const thread = agentThread(key);
  if (!['agent-model','agent-effort','agent-skills','agent-usage','agent-model-pick','agent-effort-pick','agent-skill-pick','agent-skill-file','agent-skill-detail'].includes(action)) return false;
  if (!thread) return true;
  if (['agent-model','agent-effort','agent-skills','agent-usage'].includes(action)) { agentPreferenceSheet(thread, action.replace('agent-','')); return true; }
  if (action === 'agent-skill-detail') { agentPreferenceSheet(thread,'skill-detail'); return true; }
  const previous = JSON.stringify({uiModel:thread.uiModel,uiEffort:thread.uiEffort,uiSkill:thread.uiSkill,uiSkillPaths:thread.uiSkillPaths});
  if (action === 'agent-model-pick') { const model=agentDemoModels.find(m=>m[0]===value); if (!model) return true; thread.uiModel=value; thread.uiEffort=model[2]; }
  if (action === 'agent-effort-pick') { if (!agentDemoEfforts[value] || value==='ultra' && thread.uiModel?.endsWith('luna')) return true; thread.uiEffort=value; }
  if (action === 'agent-skill-pick') { thread.uiSkill=value==='log'?'log':undefined; if(value !== 'log') delete thread.uiSkillPaths;else if(!thread.uiSkillPaths)thread.uiSkillPaths=[0,1,2,3]; }
  if (action === 'agent-skill-file') { const index=Number(value); if(!Number.isInteger(index)||index<0||index>3)return true; const paths=thread.uiSkillPaths||[0,1,2,3]; thread.uiSkillPaths=paths.includes(index)?paths.filter(i=>i!==index):[...paths,index]; }
  if (save() === false) { for (const field of ['uiModel','uiEffort','uiSkill','uiSkillPaths']) delete thread[field]; Object.assign(thread,JSON.parse(previous)); tell('未能保存选择，请重试。'); return true; }
  if (action === 'agent-skill-file') return true;
  else { close(); refreshAgentView(); }
  return true;
}

document.addEventListener('input', event => { if (event.target.id !== 'agent-skill-search') return; const query=event.target.value.trim().toLowerCase(); let count=0;for(const row of document.querySelectorAll('[data-skill-search]')) { row.hidden=!row.dataset.skillSearch.toLowerCase().includes(query);if(!row.hidden)count++; }const empty=document.querySelector('#agent-skill-empty');if(empty)empty.hidden=count>0; });

document.addEventListener('change', event => {const input=event.target;if(!input.dataset.agentSkillFile)return;const [id,index]=input.dataset.agentSkillFile.split(':');agentPreferenceAction('agent-skill-file',id,index);input.checked=(agentThread(id)?.uiSkillPaths||[0,1,2,3]).includes(Number(index));});

function agentUiSkillChip(thread) { return thread.uiSkill ? '<div class="agent-skill-chip-row"><button class="agent-skill-chip" data-act="agent-skill-detail:'+esc(thread.id)+'">/record-to-log · 示例</button>'+iconBtn('移除待发送技能','agent-skill-pick:'+thread.id+':none','x')+'</div>' : ''; }
