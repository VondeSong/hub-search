// Capture layouts after first Back, second Back, and reopening quick capture.
// node qa/android-back-check.mjs ime-hidden.json sheet-closed.json reopened.json
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
assert(process.argv.length===5,"Provide first-Back, second-Back, and reopened Android layout snapshots");
function read(file){const windows=JSON.parse(readFileSync(file,"utf8")),nodes=[];function walk(x){if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==="object"){nodes.push(x);Object.values(x).forEach(walk);}}walk(windows);return {windows,nodes};}
const [first,second,reopened]=process.argv.slice(2).map(read);
const capture=state=>state.nodes.find(n=>n.class==="android.app.Dialog"&&n.text==="速记");
const field=state=>state.nodes.find(n=>n.class==="android.widget.EditText");
assert(!first.windows.some(w=>w.type==="INPUT_METHOD"),"First Back must hide the keyboard");
assert(capture(first),"First Back must retain quick capture");
assert(field(first)?.text,"Use a nonempty draft for this check");
assert(!capture(second),"Second Back must close quick capture");
assert(second.nodes.some(n=>n.class==="android.webkit.WebView"&&n.text==="Hub"),"Second Back must retain Hub in the foreground");
assert(capture(reopened),"Quick capture must reopen");
assert.equal(field(reopened)?.text,field(first).text,"Back must preserve the native draft");
console.log(JSON.stringify({keyboardDismissed:true,sheetClosed:true,hubRetained:true,draftRestored:true}));
