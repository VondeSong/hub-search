import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bold, Hash, ImagePlus, IndentDecrease, IndentIncrease, List, ListOrdered, MoreHorizontal } from "lucide-react";

const escape = (v:string) => v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export function journalEditorMarkup(text:string) {
  const inline=(v:string)=>escape(v).replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>");
  const stack:Array<{type:string;indent:number}>=[],out:string[]=[];
  const close=()=>{const value=stack.pop();if(value)out.push(`</li></${value.type}>`);};
  for(const line of text.split("\n")){
    const match=line.match(/^(\s*)(?:([-*]) |(\d+)\. )(.*)$/),type=match?(match[2]?"ul":"ol"):"",indent=match?.[1].replace(/\t/g,"  ").length||0;
    if(!match){while(stack.length)close();out.push(`<div>${line?inline(line):"<br>"}</div>`);continue;}
    while(stack.length&&indent<stack[stack.length-1].indent)close();
    if(stack.length&&stack[stack.length-1].indent===indent&&stack[stack.length-1].type!==type)close();
    if(!stack.length||indent>stack[stack.length-1].indent){out.push(`<${type}${type==="ol"?` start="${Number(match[3])||1}"`:""}>`);stack.push({type,indent});}else out.push("</li>");
    out.push(`<li>${inline(match[4])}`);
  }
  while(stack.length)close();return text?out.join(""):"";
}
export function journalEditorText(editor:HTMLElement):string {
  const walk=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return (node.nodeValue||"").replace(/[\u200b\ufeff]/g,"");
    if(!(node instanceof HTMLElement))return "";
    if(node.tagName==="BR")return "\n";
    const body=Array.from(node.childNodes).map(walk).join("");
    if(["B","STRONG"].includes(node.tagName)||node.style.fontWeight==="bold"||Number(node.style.fontWeight)>=600)return body?`**${body}**`:"";
    if(["UL","OL"].includes(node.tagName))return Array.from(node.children).filter(n=>n.tagName==="LI").map((li,i)=>{
      const nested=Array.from(li.children).filter(n=>["UL","OL"].includes(n.tagName));
      const own=Array.from(li.childNodes).filter(n=>!(n instanceof HTMLElement&&nested.includes(n))).map(walk).join("").trimEnd();
      return (node.tagName==="OL"?`${i+(Number(node.getAttribute("start"))||1)}. `:"- ")+own+nested.map(n=>"\n"+walk(n).trimEnd().split("\n").map(l=>"  "+l).join("\n")).join("");
    }).join("\n")+"\n";
    return ["DIV","P","BLOCKQUOTE"].includes(node.tagName)?body+(body.endsWith("\n")?"":"\n"):body;
  };
  return Array.from(editor.childNodes).map(walk).join("").replace(/\n$/,"");
}
export type JournalRichEditorHandle={focus:()=>void;read:()=>string};
export const JournalRichEditor=forwardRef<JournalRichEditorHandle,{value:string;onChange:(text:string)=>void;disabled?:boolean;onPhotos:()=>void;onMore:()=>void;moreOpen?:boolean;onSubmit:()=>void;actions?:ReactNode}>(({value,onChange,disabled,onPhotos,onMore,moreOpen,onSubmit,actions},ref)=>{
  const editor=useRef<HTMLDivElement>(null),selection=useRef<Range|null>(null),composing=useRef(false),latest=useRef(value),emitted=useRef<string|null>(null);
  const [listOpen,setListOpen]=useState(false),[bold,setBold]=useState(false);
  latest.current=value;
  // React only handles autoFocus for form controls; dialog focus restoration needs the global attribute here.
  useLayoutEffect(()=>{editor.current?.setAttribute("autofocus","");},[]);
  useEffect(()=>{const el=editor.current;if(el&&journalEditorText(el)!==value&&emitted.current!==value)el.innerHTML=journalEditorMarkup(value);},[value]);
  useImperativeHandle(ref,()=>({focus:()=>editor.current?.focus({preventScroll:true}),read:()=>editor.current?journalEditorText(editor.current):latest.current}),[]);
  const remember=()=>{const s=window.getSelection();if(s?.rangeCount&&editor.current?.contains(s.getRangeAt(0).commonAncestorContainer))selection.current=s.getRangeAt(0).cloneRange();};
  const changed=()=>{if(editor.current){const text=journalEditorText(editor.current);emitted.current=text;onChange(text);try{setBold(document.queryCommandState("bold"));}catch{}}};
  const command=(cmd:string)=>{
    if(disabled||composing.current||!editor.current)return;editor.current.focus({preventScroll:true});
    const s=window.getSelection();if(selection.current&&editor.current.contains(selection.current.commonAncestorContainer)){s?.removeAllRanges();s?.addRange(selection.current);}
    // WebView editing commands preserve native undo and IME selection; keep this adapter local to the journal.
    document.execCommand(cmd==="tag"?"insertText":cmd,false,cmd==="tag"?"#":undefined);remember();changed();setListOpen(false);
  };
  return <><div ref={editor} className="journal-rich-editor" role="textbox" tabIndex={0} aria-label="此刻的想法" aria-multiline="true" data-empty={!value.trim()} data-placeholder="现在的想法是…" contentEditable={!disabled} suppressContentEditableWarning
    onInput={changed} onBlur={remember} onKeyUp={remember} onPointerUp={remember}
    onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;changed();}}
    onPaste={event=>{event.preventDefault();document.execCommand("insertText",false,event.clipboardData.getData("text/plain"));changed();}}
    onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&!event.nativeEvent.isComposing&&!composing.current){event.preventDefault();onSubmit();}}}/>
    <div className="journal-rich-tools" aria-label="正文格式"><button type="button" aria-label="插入标签" disabled={disabled} onPointerDown={e=>{e.preventDefault();remember();}} onClick={()=>command("tag")}><Hash size={21}/></button><button type="button" aria-label="添加照片" disabled={disabled} onPointerDown={remember} onClick={onPhotos}><ImagePlus size={21}/></button><span/>
      <button type="button" aria-label="加粗" aria-pressed={bold} disabled={disabled} onPointerDown={e=>{e.preventDefault();remember();}} onClick={()=>command("bold")}><Bold size={20}/></button><button type="button" aria-label="列表格式" aria-expanded={listOpen} disabled={disabled} onPointerDown={e=>{e.preventDefault();remember();}} onClick={()=>setListOpen(!listOpen)}><List size={21}/></button><span/>
      <button type="button" aria-label="更多记录选项" aria-expanded={moreOpen} disabled={disabled} onPointerDown={e=>{e.preventDefault();remember();}} onClick={onMore}><MoreHorizontal size={21}/></button>
      {listOpen&&<div className="journal-rich-list" role="group" aria-label="列表格式">{([["insertUnorderedList","无序列表",List],["insertOrderedList","有序列表",ListOrdered],["indent","增加缩进",IndentIncrease],["outdent","减少缩进",IndentDecrease]] as const).map(([cmd,label,Icon])=><button type="button" key={cmd} aria-label={label} onPointerDown={e=>{e.preventDefault();remember();}} onClick={()=>command(cmd)}><Icon size={20}/></button>)}</div>}
      {actions}
    </div></>;
});
