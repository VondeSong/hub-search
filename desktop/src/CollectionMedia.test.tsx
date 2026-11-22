// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionGalleryCover } from "./CollectionGalleryCover";
import { CollectionAttachment } from "./CollectionAttachment";
import { PreviewMarkdownMedia } from "./PreviewMarkdown";
import { CollectionPostBody, type CollectionPost } from "./CollectionPostBody";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement;
let root: Root;

it("renders reply and quote assets using the original item key and local media protocol",async()=>{
 const post={id:"100",text:"主帖正文",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/100",quotedText:"",contentStatus:"complete",links:[],media:[]};
 const media={kind:"photo",url:"https://pbs.twimg.com/quoted.jpg"};
 invoke.mockImplementation(async command=>command==="collection_media_preview"?{source:"http://craft-media.localhost/collection/15",mimeType:"image/png",mediaType:"image"}:[]);
 await act(async()=>root.render(<CollectionPostBody itemKey="original-item" open={vi.fn(async()=>{})} post={{...post,thread:[{...post,id:"101",text:"楼主续帖",quote:{...post,id:"90",text:"引用原文",media:[media]}}]}}/>));
 expect(host.textContent).toContain("楼主续帖");expect(host.querySelector('.collection-quote')?.textContent).toContain("引用原文");
 expect(invoke).toHaveBeenCalledWith("collection_media_preview",{key:"original-item",url:media.url});
 expect(host.querySelector('img')?.src).toBe("http://craft-media.localhost/collection/15");
 expect(invoke.mock.calls.every(call=>["collection_media_preview","reading_attachment_status","reading_copy_status"].includes(call[0]))).toBe(true);
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invoke.mockResolvedValue([]);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: {isIntersecting: boolean}[]) => void) {}
    observe() { this.callback([{isIntersecting:true}]); }
    disconnect() {}
  });
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();invoke.mockReset();});
async function mount() {
  await act(async()=>root.render(<PreviewMarkdownMedia provider="obsidian" spaceId="" documentId="item" collectionKey="item" src="https://video.twimg.com/media"/>));
}
it("renders saved images through the local protocol and supports zoom",async()=>{
  invoke.mockResolvedValue({source:"http://craft-media.localhost/collection/12",mimeType:"image/png",mediaType:"image"});
  await mount();
  expect(invoke).toHaveBeenCalledWith("collection_media_preview",{key:"item",url:"https://video.twimg.com/media"});
  expect(host.querySelector("img")?.src).toBe("http://craft-media.localhost/collection/12");
  await act(async()=>host.querySelector<HTMLButtonElement>('.preview-image-zoom')!.click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
it("waits for a click before playing a local video",async()=>{
  invoke.mockResolvedValue({source:"http://craft-media.localhost/collection/13",mimeType:"video/mp4",mediaType:"video"});
  await mount();expect(host.querySelector("video")?.autoplay).toBe(false);expect(host.querySelector("video")?.src).toContain("/collection/13#t=0.1");
  await act(async()=>host.querySelector<HTMLButtonElement>('.preview-video-poster')!.click());
  expect(host.querySelector("video")?.controls).toBe(true);
  expect(host.querySelector("source")?.src).toBe("http://craft-media.localhost/collection/13");
});
it("reports a missing local file without fetching the remote media",async()=>{
  invoke.mockRejectedValue("本地附件已移动或不存在，请重试下载");await mount();
  expect(host.textContent).toContain("本地附件已移动");
  expect(host.querySelector("img,video")).toBeNull();
  expect(invoke.mock.calls.every(call=>call[0]==="collection_media_preview")).toBe(true);
});

it("gallery loads local video only near the viewport and never autoplays",async()=>{
  let reveal: (entries:{isIntersecting:boolean}[])=>void=()=>{};
  vi.stubGlobal("IntersectionObserver",class {constructor(callback:typeof reveal){reveal=callback;}observe(){}disconnect(){}});
  invoke.mockResolvedValue({source:"http://craft-media.localhost/collection/13",mediaType:"video",mimeType:"video/mp4"});
  await act(async()=>root.render(<CollectionGalleryCover itemKey="item" saved media={{url:"https://video.twimg.com/media",kind:"video"}}/>));
  expect(invoke).not.toHaveBeenCalled();
  expect(host.textContent).toContain("视频");
  await act(async()=>reveal([{isIntersecting:true}]));
  expect(host.querySelector("video")?.src).toBe("http://craft-media.localhost/collection/13");
  expect(host.querySelector("video")?.autoplay).toBe(false);
  expect(host.querySelector("video")?.preload).toBe("metadata");
  expect(host.textContent).not.toContain("视频");
  expect(host.querySelector('.collection-gallery-video[title="视频"] svg')).not.toBeNull();
});
it.each(["photo","video","animated_gif"])("gallery leaves unsaved %s attachments as placeholders",async kind=>{
  await act(async()=>root.render(<CollectionGalleryCover itemKey="item" saved={false} text="正文有附件" media={{url:"https://pbs.twimg.com/media",kind}}/>));
  expect(invoke).not.toHaveBeenCalled();expect(host.querySelector("img,video")).toBeNull();
  expect(host.textContent).toContain("附件未下载");
  expect(host.textContent).not.toContain("正文有附件");
});
it("uses a saved Telegram thumbnail as the gallery cover without loading the video",async()=>{
  invoke.mockResolvedValue({source:"http://craft-media.localhost/collection/20",mediaType:"image",mimeType:"image/jpeg"});
  await act(async()=>root.render(<CollectionGalleryCover itemKey="tg" saved media={{url:"telegram://7/video/video.mp4",previewUrl:"telegram://7/thumb/cover.jpg",kind:"video"}}/>));
  expect(invoke).toHaveBeenCalledWith("collection_media_preview",{key:"tg",url:"telegram://7/thumb/cover.jpg"});
  expect(host.querySelector("img")?.src).toContain("/collection/20");expect(host.querySelector("video")).toBeNull();expect(host.textContent).not.toContain("视频");
  expect(host.querySelector('.collection-gallery-video[title="视频"] svg')).not.toBeNull();
});
it("opens Telegram documents by collection identity without exposing a local path",async()=>{
  invoke.mockResolvedValue(undefined);
  await act(async()=>root.render(<CollectionAttachment itemKey="telegram:7:42:9" media={{kind:"document",url:"telegram://7/file_id/%E7%A0%94%E7%A9%B6.pdf"}}/>));
  expect(host.textContent).toContain("研究.pdf");expect(invoke).not.toHaveBeenCalled();
  await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
  expect(invoke).toHaveBeenCalledWith("open_collection_attachment",{key:"telegram:7:42:9",url:"telegram://7/file_id/%E7%A0%94%E7%A9%B6.pdf"});
});
it("renders Telegram audio through the local media protocol without autoplay",async()=>{
  invoke.mockResolvedValue({source:"http://craft-media.localhost/collection/21",mediaType:"audio",mimeType:"audio/ogg"});
  await act(async()=>root.render(<CollectionAttachment itemKey="tg" media={{kind:"audio",url:"telegram://7/voice/voice.ogg"}}/>));
  expect(host.querySelector("audio")?.src).toContain("/collection/21");expect(host.querySelector("audio")?.autoplay).toBe(false);expect(host.querySelector("video,img")).toBeNull();
});

it("shows the text-only body in the gallery cover without requesting media or interpreting markup",async()=>{
  const text="第一行标题\n第二行正文 <img src=x onerror=alert(1)>";
  await act(async()=>root.render(<CollectionGalleryCover itemKey="text-only" saved={false} text={text}/>));
  expect(host.querySelector(".collection-gallery-text")?.textContent).toBe(text);
  expect(host.querySelector("img,video,script")).toBeNull();
  expect(host.textContent).not.toContain("文字");
  expect(invoke).not.toHaveBeenCalled();
});

const examplePost:CollectionPost={id:"100",text:"主帖",authorName:"主作者",authorHandle:"owner",publishedAt:"2026-10-05T02:00:00Z",url:"https://x.com/owner/status/100",quotedText:"",contentStatus:"complete",links:[],media:[]};
it("displays all authors chronologically with source links and reply targets instead of numbered continuation headings",async()=>{
 const open=vi.fn(async()=>{});
 const reply=(id:string,author:string,parent:string):CollectionPost=>({...examplePost,id,text:`回复 ${id}`,authorName:author,authorHandle:author,replyToId:parent,replyToHandle:"guest",url:`https://x.com/${author}/status/${id}`});
 await act(async()=>root.render(<CollectionPostBody itemKey="item" open={open} post={{...examplePost,thread:[reply("103","owner","102"),reply("101","guest","100"),reply("102","guest","101")],replyCount:3,threadStatus:"complete",threadFormat:2}}/>));
 expect([...host.querySelectorAll('.collection-post-text')].map(el=>el.textContent)).toEqual(["主帖","回复 101","回复 102","回复 103"]);
 expect(host.querySelector('h2')).toBeNull();expect(host.textContent).not.toContain("楼主续帖");
 expect(host.querySelectorAll('time')).toHaveLength(4);
 const target=host.querySelector<HTMLAnchorElement>('.collection-reply-to')!;
 expect(target.textContent).toBe("回复 @guest");
 await act(async()=>target.click());expect(open).toHaveBeenCalledWith("https://x.com/i/status/101");
 expect(host.textContent).toContain("已获取 3 条回复 · X 显示 3 条");
});
it("labels and preserves own and quoted video versions while sharing identical asset URLs",async()=>{
 invoke.mockImplementation(async(_command:string,args:{url:string})=>({source:`http://craft-media.localhost/collection/${args.url.endsWith('own.mp4')?1:2}`,mimeType:"video/mp4",mediaType:"video"}));
 const own={kind:"video",url:"https://video.twimg.com/own.mp4"};const quoted={kind:"video",url:"https://video.twimg.com/quoted.mp4"};
 await act(async()=>root.render(<CollectionPostBody itemKey="item" open={vi.fn(async()=>{})} post={{...examplePost,media:[own],quote:{...examplePost,id:"90",text:"被引用内容",media:[quoted]},thread:[{...examplePost,id:"101",media:[own]}]}}/>));
 expect(host.querySelectorAll('video')).toHaveLength(2);
 expect(invoke.mock.calls.filter(call=>call[0]==="collection_media_preview")).toHaveLength(2);
 const ownContainer=host.querySelector('.collection-own-media')!;const quote=host.querySelector('.collection-quote')!;
 expect(ownContainer.textContent).toContain("本帖附件");expect(quote.textContent).toContain("引用原帖");
 expect(ownContainer.compareDocumentPosition(quote)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(quote.querySelector('video')?.src).toContain('/collection/2');
});
it("reports available reply counts and limits without falsely claiming every X reply was retrieved",async()=>{
 await act(async()=>root.render(<CollectionPostBody itemKey="item" open={vi.fn(async()=>{})} post={{...examplePost,replyCount:295,thread:[{...examplePost,id:"101"}],threadStatus:"limited",threadFormat:2,threadError:"X 本次未返回更多可访问的回复"}}/>));
 expect(host.textContent).toContain("已获取 1 条回复 · X 显示 295 条");expect(host.textContent).toContain("可访问");
 expect(host.textContent).not.toContain("楼主串帖尚待补全");expect(host.textContent).not.toContain("回复尚待补全");
 await act(async()=>root.render(<CollectionPostBody itemKey="item" open={vi.fn(async()=>{})} post={{...examplePost,replyCount:2,threadStatus:"complete"}}/>));
 expect(host.textContent).toContain("回复尚待补全");
});

it("keeps original attachments in editorial paragraph order and keeps surplus files", async () => {
  const post = {
    ...examplePost,
    text: "第一段 **粗体**\n\n第二段\n\n- 一个列表",
    media: ["a.pdf", "b.pdf", "c.pdf"].map(name => ({kind:"file", url:"https://example.com/"+name})),
  };
  invoke.mockImplementation(async command => command==="reading_attachment_status" ? [] : undefined);
  await act(async () => root.render(<CollectionPostBody post={post} itemKey="inline-item" open={vi.fn(async()=>{})} inlineMedia/>));
  const body = document.querySelector(".collection-post-text")!;
  expect([...body.children].map(node=>node.tagName)).toEqual(["P","DIV","P","DIV","UL","DIV"]);
  expect([...body.querySelectorAll(".reading-inline-file strong")].map(node=>node.textContent)).toEqual(["a.pdf","b.pdf","c.pdf"]);
  expect(body.querySelector("p strong")?.textContent).toBe("粗体");
  expect(invoke).not.toHaveBeenCalledWith("transfer_reading_attachment",expect.anything());
  const download=body.querySelector<HTMLButtonElement>(".reading-inline-download")!;
  await act(async()=>download.click());
  expect(invoke).toHaveBeenCalledWith("transfer_reading_attachment",{key:"inline-item",url:"https://example.com/a.pdf",upload:false});
  expect(body.querySelector(".reading-inline-file")?.textContent).toContain("本机可用");
});
