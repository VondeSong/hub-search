export type JournalCaptureTask={title:string;completed:boolean};

export function splitJournalCapture(text:string){
 const lines:string[]=[],tasks:JournalCaptureTask[]=[];
 let fence:string|undefined;
 for(const line of text.split(/\r?\n/)){
  const boundary=line.match(/^ {0,3}([~`])\1{2,}/)?.[0].trimStart();
  if(fence){
   if(boundary&&boundary[0]===fence[0]&&boundary.length>=fence.length&&line.trim()===boundary)fence=undefined;
   lines.push(line);continue;
  }
  if(boundary){fence=boundary;lines.push(line);continue;}
  const match=line.match(/^ {0,3}[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/);
  if(!match){lines.push(line);continue;}
  const title=match[2]?.trim();
  if(title)tasks.push({title,completed:match[1]!==" "});
 }
 return {text:lines.join("\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g,""),tasks};
}

export function insertJournalTask(text:string,start:number,end:number){
 const left=text.slice(0,start),right=text.slice(end),selected=text.slice(start,end);
 const lineStart=left.slice(left.lastIndexOf("\n")+1).trim()==="";
 const prefix=(lineStart?"":"\n")+"- [ ] ";
 // Keep unrelated text to the right of a mid-line insertion on its own line.
 const separate=(!lineStart||selected.length>0)&&right&&!right.startsWith("\n")?"\n":"";
 return {text:left+prefix+selected+separate+right,caret:start+prefix.length+selected.length};
}
