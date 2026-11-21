// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useAgentConversationScroll } from "./useAgentConversationScroll";

let root:Root,host:HTMLDivElement,resize:()=>void,disconnect:ReturnType<typeof vi.fn>;
let height=1000;
function Conversation({work="one",version=1}:{work?:string;version?:number}) {
 const scroll=useAgentConversationScroll(true,work,version);
 return <><div ref={scroll.element} tabIndex={0} onScroll={scroll.onScroll}><div ref={scroll.content}><details onClickCapture={scroll.holdPosition}><summary>处理过程</summary>保存的正文</details></div></div>{scroll.showLatest&&<button onClick={scroll.jumpToLatest}>回到最新内容</button>}</>;
}
beforeEach(()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});height=1000;
 disconnect=vi.fn();vi.stubGlobal('ResizeObserver',class {constructor(callback:()=>void){resize=callback;}observe(){}disconnect=disconnect;});
 vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockImplementation(()=>height);
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(200);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("follows a pinned conversation when streamed content grows or the process collapses",async()=>{
 await act(async()=>root.render(<Conversation/>));const pane=host.firstElementChild as HTMLElement;
 expect(pane.scrollTop).toBe(1000);
 height=1800;await act(async()=>resize());expect(pane.scrollTop).toBe(1800);
 height=700;await act(async()=>resize());expect(pane.scrollTop).toBe(700);
 expect(host.querySelector('button')).toBeNull();
});
it("preserves a reader's position through new results, then follows again only after an explicit jump",async()=>{
 await act(async()=>root.render(<Conversation/>));const pane=host.firstElementChild as HTMLElement;
 pane.scrollTop=120;await act(async()=>pane.dispatchEvent(new Event('scroll',{bubbles:true})));
 height=1800;await act(async()=>root.render(<Conversation version={2}/>));await act(async()=>resize());
 expect(pane.scrollTop).toBe(120);expect(host.querySelector('button')?.textContent).toBe('回到最新内容');
 await act(async()=>host.querySelector('button')!.click());expect(pane.scrollTop).toBe(1800);
 expect(document.activeElement).toBe(pane);
 height=2100;await act(async()=>resize());expect(pane.scrollTop).toBe(2100);
});
it("opens another Work at its latest content and releases the observer on unmount",async()=>{
 await act(async()=>root.render(<Conversation/>));const pane=host.firstElementChild as HTMLElement;
 pane.scrollTop=100;await act(async()=>pane.dispatchEvent(new Event('scroll',{bubbles:true})));
 await act(async()=>root.render(<Conversation work="two"/>));expect(pane.scrollTop).toBe(1000);expect(disconnect).toHaveBeenCalled();
});
it("does not offer a jump just because a disclosure was clicked with no overflow",async()=>{
 height=120;await act(async()=>root.render(<Conversation/>));
 await act(async()=>host.querySelector('summary')!.click());await act(async()=>resize());
 expect(host.querySelector('button')).toBeNull();
});
it("clears the jump after a collapsed process fits the viewport and resumes following",async()=>{
 await act(async()=>root.render(<Conversation/>));const pane=host.firstElementChild as HTMLElement;
 pane.scrollTop=120;await act(async()=>pane.dispatchEvent(new Event('scroll',{bubbles:true})));
 expect(host.querySelector('button')).not.toBeNull();
 await act(async()=>host.querySelector('summary')!.click());height=150;await act(async()=>resize());
 expect(host.querySelector('button')).toBeNull();
 height=900;await act(async()=>resize());expect(pane.scrollTop).toBe(900);
});
