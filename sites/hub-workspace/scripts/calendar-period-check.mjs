import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/calendar-period.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {calendarDateKey,calendarPeriodKey}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
assert.equal(calendarPeriodKey(2026,11),'2026-11');
assert.equal(calendarPeriodKey(2025,1),'2025-01');
assert.equal(calendarPeriodKey(2028,2),'2028-02');
assert.equal(calendarPeriodKey(100,1),'0100-01');
for(const [year,month] of [[99,1],[10000,1],[2026,0],[2026,13],[2026.5,4],[NaN,1]])assert.equal(calendarPeriodKey(year,month),null);
for(const [year,month] of [[100,1],[100,11],[9999,12]]){
 const first=new Date(year,month-1,1),keys=[];
 for(let i=0;i<42;i++){
  const date=new Date(year,month-1,1-first.getDay()+i),key=calendarDateKey(date);
  const valid=calendarPeriodKey(date.getFullYear(),date.getMonth()+1)!==null;
  if(valid){assert.match(key,/^\d{4}-\d{2}-\d{2}$/);keys.push(key);}
  else assert.ok(date.getFullYear()<100||date.getFullYear()>9999);
 }
 assert.ok(keys.includes(calendarPeriodKey(year,month)+'-01'));
 assert.equal(new Set(keys).size,keys.length);
}
console.log('✓ 跨年、闰年月份、前导零与无效年月边界');
