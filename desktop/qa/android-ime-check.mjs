// Capture with: android --no-metrics layout --device SERIAL --output layout.json
// Verify with the real IME open: node qa/android-ime-check.mjs layout.json
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const file=process.argv[2];
assert(file,"Provide an Android CLI layout JSON snapshot");
const nodes=[];
function walk(value){
 if(Array.isArray(value))value.forEach(walk);
 else if(value&&typeof value==="object"){nodes.push(value);Object.values(value).forEach(walk);}
}
walk(JSON.parse(readFileSync(file,"utf8")));
const ime=nodes.find(node=>node.type==="INPUT_METHOD");
const dialog=nodes.find(node=>node.class==="android.app.Dialog"&&node.text==="速记");
const save=nodes.find(node=>node.class==="android.widget.Button"&&node.text==="记下");
assert(ime,"Keyboard must be open for this regression check");
assert(dialog,"Quick capture must be open");
assert(save,"Save must remain accessible while the keyboard is open");
const bounds=node=>{const parts=node.bounds?.match(/-?\d+/g)?.map(Number);assert(parts?.length===4,"Invalid UI bounds");return parts;};
const keyboard=bounds(ime),button=bounds(save);
assert(button[0]>=0&&button[1]>=0&&button[2]>button[0]&&button[3]>button[1],"Save button must have visible bounds");
assert(button[3]<=keyboard[1],"Keyboard covers the save button");
console.log(JSON.stringify({saveVisible:true,saveBottom:button[3],keyboardTop:keyboard[1]}));
