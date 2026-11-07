import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'artifacts', 'agent-native-20261022');
fs.mkdirSync(evidence, {recursive:true});
const backup = path.join(root, '.local', 'agent-native-20261022', 'baseline');
fs.mkdirSync(backup, {recursive:true});
const files = [];
for (const relative of ['src','src-tauri/src/agent_work','src-tauri/src/model_runtime','scripts']) {
  for (const name of fs.readdirSync(path.join(root,relative),{recursive:true})) {
    const file=path.join(relative,name);
    if(fs.statSync(path.join(root,file)).isFile() && /\.(rs|tsx?|css|mjs|ps1)$/.test(file)) files.push(file);
  }
}
files.push('src-tauri/src/agent_work.rs','src-tauri/src/model_runtime.rs','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','docs/ASSISTANT_INTERACTION.md','docs/AGENTS_ROADMAP.md');
const baseline=[];
for(const file of [...new Set(files)].sort()){
  const source=path.join(root,file); if(!fs.existsSync(source))continue;
  const bytes=fs.readFileSync(source); const target=path.join(backup,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});
  baseline.push({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
}
fs.writeFileSync(path.join(evidence,'baseline.json'),JSON.stringify({root,backup,files:baseline},null,2));
console.log(JSON.stringify({root,evidence,backup,files:baseline.length}));
