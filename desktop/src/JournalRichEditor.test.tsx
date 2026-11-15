// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {JournalRichEditor,journalEditorMarkup,journalEditorText} from "./JournalRichEditor";
const roots:Array<{root:ReturnType<typeof createRoot>;node:HTMLElement}>=[];
afterEach(async()=>{for(const {root,node}of roots.splice(0)){await act(async()=>root.unmount());node.remove();}vi.restoreAllMocks();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it("round trips blank lines, bold, numbered and nested lists without injecting HTML",()=>{
 const text="正文\n\n**加粗**\n- 主项\n  - 子项\n  - 下一项\n- 后项\n\n3. 编号\n4. 后续\n<script>not executable</script>";
 const node=document.createElement("div");node.innerHTML=journalEditorMarkup(text);
 expect(node.querySelector("script")).toBeNull();expect(node.querySelector("ul ul")).not.toBeNull();expect(node.querySelector("ol")?.start).toBe(3);
 expect(journalEditorText(node)).toBe(text);
});
it("keeps edited DOM and selection through own updates, but clears after a successful external reset",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const node=document.createElement("div");document.body.append(node);const root=createRoot(node);roots.push({root,node});const change=vi.fn();
 const render=(value:string)=>root.render(<JournalRichEditor value={value} onChange={change} onPhotos={()=>{}} onMore={()=>{}} onSubmit={()=>{}}/>);
 await act(async()=>render("restored"));const input=node.querySelector<HTMLElement>("[role=textbox]")!;input.focus();input.innerHTML="<div>changed</div>";
 await act(async()=>input.dispatchEvent(new Event("input",{bubbles:true})));expect(change).toHaveBeenLastCalledWith("changed");
 const child=input.firstChild;await act(async()=>render("changed"));expect(input.firstChild).toBe(child);
 await act(async()=>render(""));expect(journalEditorText(input)).toBe("");
});
it("does not submit or format while composition is in progress",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const node=document.createElement("div");document.body.append(node);const root=createRoot(node);roots.push({root,node});const submit=vi.fn(),execute=vi.fn();Object.defineProperty(document,"execCommand",{configurable:true,value:execute});
 await act(async()=>root.render(<JournalRichEditor value="中文" onChange={()=>{}} onPhotos={()=>{}} onMore={()=>{}} onSubmit={submit}/>));const input=node.querySelector("[role=textbox]")!;
 await act(async()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));
 await act(async()=>{input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true}));(node.querySelector('[aria-label="加粗"]')as HTMLElement).click();});expect(submit).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
 await act(async()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
 await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true})));expect(submit).toHaveBeenCalledOnce();
});
