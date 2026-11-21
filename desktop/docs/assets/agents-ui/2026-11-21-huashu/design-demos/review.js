const directions = [
  ['quiet.html','A 轻描边'], ['grid.html','B 双列快捷操作'],
  ['glass.html','C 磨砂浮窗']
];
const nav = document.createElement('nav');
nav.setAttribute('aria-label','切换 Agents 设计方向');
const frame = document.createElement('iframe');
frame.title = 'Hub 工作台 · Agents 交互预览';
frame.src = '/?assistant=1';
let treatment = document.querySelector('#treatment').innerHTML;
let requestId = 0;
function applyTreatment() {
  const doc = frame.contentDocument;
  if (!doc?.head) return;
  doc.getElementById('agents-review-style')?.remove();
  const template = doc.createElement('template');
  template.innerHTML = treatment;
  const style = template.content.querySelector('style');
  style.id = 'agents-review-style';
  doc.head.append(style);
}
function markDirection() {
  for (const link of nav.children) {
    if (link.pathname.replace(/\.html$/, '') === location.pathname.replace(/\.html$/, '')) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
}
async function switchDirection(url, push) {
  const id = ++requestId;
  try {
    const response = await fetch(url);
    if (!response.ok) throw Error('load');
    const doc = new DOMParser().parseFromString(await response.text(),'text/html');
    if (id !== requestId) return;
    treatment = doc.querySelector('#treatment').innerHTML;
    if (push) history.pushState(null,'',url);
    document.title = doc.title;
    markDirection();
    applyTreatment();
  } catch {
    if (id === requestId) location.assign(url);
  }
}
for (const [path,label] of directions) {
  const link = document.createElement('a');
  link.href = path;
  link.textContent = label;
  link.onclick = event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchDirection(link.href,true);
  };
  nav.append(link);
}
frame.addEventListener('load',applyTreatment);
window.addEventListener('popstate',() => switchDirection(location.href,false));
document.body.append(nav,frame);
markDirection();
