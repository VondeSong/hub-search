import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { runtimeCapabilities } from "./RuntimePlatform";
import { invoke } from "@tauri-apps/api/core";
import type { Root } from "mdast";
import type { ReadingAttachmentState } from "./ReadingAttachments";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CollectionAttachment, InlineReadingAttachment, type CollectionAttachmentMedia } from "./CollectionAttachment";
export type CollectionPost={source?:string;origin?:{name:string;url:string};id:string;text:string;authorName:string;authorHandle:string;publishedAt:string;url:string;quotedText:string;contentStatus:string;links:string[];media:CollectionAttachmentMedia[];quote?:CollectionPost|null;quoteId?:string;thread?:CollectionPost[];allMedia?:CollectionPost["media"];threadStatus?:string;replyToId?:string;replyToHandle?:string;replyCount?:number;threadFormat?:number;threadError?:string};
export const collectionAttachments=(post:CollectionPost)=>post.allMedia?.length?post.allMedia:post.media;
function timestamp(value:string) {
 const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleString(undefined,{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
// Only identical URLs are shared assets; separately uploaded versions remain distinct.
function visibleMedia(post:CollectionPost,seen:Set<string>,depth=0):CollectionPost {
 const media=post.media.filter((asset,index)=>{const key=asset.url||asset.previewUrl||`${post.id}:${index}`;if(seen.has(key))return false;seen.add(key);return true;});
 return {...post,media,quote:post.quote&&depth<5?visibleMedia(post.quote,seen,depth+1):post.quote};
}
function insertAttachments(count: number) {
  return (tree: Root) => {
    if (!count) return;
    let index = 0;
    const placeholder = (): Root["children"][number] => ({
      type: "paragraph",
      children: [],
      data: { hName: "div", hProperties: { "data-reading-attachment": index++ } },
    });
    tree.children = tree.children.flatMap(node => node.type === "paragraph" && index < count ? [node, placeholder()] : [node]);
    while (index < count) tree.children.push(placeholder());
  };
}

const MediaSlots = createContext<ReactNode[]>([]);
const ReadingMediaSlot: NonNullable<Components["div"]> = ({node,children})=>{
 const attachments=useContext(MediaSlots);
 const index=node?.properties["data-reading-attachment"];
 return index==null?<div>{children}</div>:attachments[Number(index)];
};

function Text({text,open,attachments=[]}:{text:string;open:(url:string)=>Promise<void>;attachments?:ReactNode[]}) {
 return <MediaSlots.Provider value={attachments}><div className="collection-post-text">
   <ReactMarkdown remarkPlugins={[remarkGfm, [insertAttachments, attachments.length]]} skipHtml components={{
     a:({href,children})=><a className="preview-text-link" href={href} onClick={event=>{event.preventDefault();if(href)void open(href);}}>{children}</a>,
     img:({alt})=><span>{alt}</span>,
     div:ReadingMediaSlot,
   }}>{text}</ReactMarkdown>
 </div></MediaSlots.Provider>;
}

type InlineAttachments = { saved: string[]; states: ReadingAttachmentState[]; onInspect?: () => void };
function Body({post,itemKey,open,depth=0,inline}:{post:CollectionPost;itemKey:string;open:(url:string)=>Promise<void>;depth?:number;inline?:InlineAttachments}) {
 const attachments = post.media.map((media,index) => {
   const key = media.url+":"+index;
   if (!inline) return <CollectionAttachment key={key} media={media} itemKey={itemKey}/>;
   const state = inline.states.find(item=>item.url===media.url);
   return <InlineReadingAttachment key={key} media={media} itemKey={itemKey} local={state?.local ?? inline.saved.includes(media.url)} size={state?.size} onInspect={inline.onInspect}/>;
 });
 const flowAttachments = inline && post.source !== "web";
 return <>{post.origin&&<p className="collection-origin">转发自 {post.origin.url?<a className="preview-text-link" href={post.origin.url} onClick={e=>{e.preventDefault();void open(post.origin!.url);}}>{post.origin.name||"原始消息"}</a>:post.origin.name||"原始消息"}</p>}
 {post.source==="web"?<pre className="collection-public-snapshot">{runtimeCapabilities.mobile ? post.text.split(/(\r?\n)/).map((part,i)=>i%2 ? part : <span data-reading-line key={i}>{part}</span>) : post.text}</pre>:<Text text={post.text} open={open} attachments={flowAttachments?attachments:undefined}/>}
 {!flowAttachments&&attachments.length>0&&<div className="collection-own-media">{post.quote&&<small className="collection-media-source">本帖附件</small>}<div className="collection-media">{attachments}</div></div>}
 {!!post.links.length&&<div className="collection-detail-links">{post.links.filter(url=>!post.text.includes(url)).map(url=><a className="preview-text-link" key={url} href={url} onClick={event=>{event.preventDefault();void open(url);}}>{url}</a>)}</div>}
 {post.quote&&depth<5?<blockquote className="collection-quote" aria-label="引用原帖"><header><a className="preview-text-link" href={post.quote.url} onClick={event=>{event.preventDefault();void open(post.quote!.url);}}>引用原帖 · {post.quote.authorName} @{post.quote.authorHandle}</a><time dateTime={post.quote.publishedAt}>{timestamp(post.quote.publishedAt)}</time></header><Body post={post.quote} itemKey={itemKey} open={open} depth={depth+1} inline={inline}/></blockquote>:post.quotedText?<blockquote><Text text={post.quotedText} open={open}/></blockquote>:post.quoteId?<p className="collections-note"><a className="preview-text-link" href={`https://x.com/i/status/${post.quoteId}`} onClick={event=>{event.preventDefault();void open(`https://x.com/i/status/${post.quoteId}`);}}>引用原帖</a> · 引用内容暂不可用</p>:null}
 {post.contentStatus==="partial"&&<p className="collections-note">正文可能不完整，请打开原文查看。</p>}</>;
}
export function CollectionPostBody({post,itemKey,open,inlineMedia,savedMedia,onInspect}:{post:CollectionPost;itemKey:string;open:(url:string)=>Promise<void>;inlineMedia?:boolean;savedMedia?:string[];onInspect?:()=>void}) {
 const [attachmentStates,setAttachmentStates] = useState<ReadingAttachmentState[]>([]);
 const hasMedia = collectionAttachments(post).length>0;
 useEffect(()=>{
   if(!inlineMedia||!hasMedia)return;
   let active=true, generation=0;
   const read=()=>{
     const current=++generation;
     void invoke<ReadingAttachmentState[]>("reading_attachment_status",{key:itemKey}).then(states=>{
       if(active&&current===generation&&Array.isArray(states))setAttachmentStates(states);
     }).catch(()=>{/* Local, registered files remain readable through the existing media loader. */});
   };
   const changed=(event:Event)=>{if((event as CustomEvent<string>).detail===itemKey)read();};
   setAttachmentStates([]);
   read();
   window.addEventListener("hub:reading-attachment-ready",changed);
   return()=>{active=false;window.removeEventListener("hub:reading-attachment-ready",changed);};
 },[itemKey,inlineMedia,hasMedia]);
 const inline=inlineMedia?{saved:savedMedia||[],states:attachmentStates,onInspect}:undefined;
 const parts=[post,...(post.thread||[])].sort((a,b)=>a.id.length-b.id.length||a.id.localeCompare(b.id));
 const seen=new Set<string>();const visible=parts.map(part=>visibleMedia(part,seen));
 const replies=post.thread?.length||0;
 const pending=["pending","partial"].includes(post.threadStatus||"")||((post.threadFormat||0)<2&&(post.replyCount||0)>0);
 const limited=post.threadStatus==="limited";
 return <div className="collection-posts">{visible.map((part,index)=><section className={index?"collection-thread-part":"collection-main-post"} key={part.id}>
 {parts.length>1&&<header className="collection-thread-source"><a className="preview-text-link" href={part.url} onClick={event=>{event.preventDefault();void open(part.url);}}>{part.authorName} @{part.authorHandle}</a><time dateTime={part.publishedAt}>{timestamp(part.publishedAt)}</time>{part.replyToId&&part.replyToId!==post.id&&<a className="preview-text-link collection-reply-to" href={`https://x.com/i/status/${part.replyToId}`} onClick={event=>{event.preventDefault();void open(`https://x.com/i/status/${part.replyToId}`);}}>回复 {part.replyToHandle?`@${part.replyToHandle}`:parts.find(parent=>parent.id===part.replyToId)?.authorName||"原帖"}</a>}</header>}
 <Body post={part} itemKey={itemKey} open={open} inline={inline}/></section>)}
 {(replies>0||pending||limited)&&<footer className="collection-replies-summary"><p>已获取 {replies} 条回复{typeof post.replyCount==="number"?` · X 显示 ${post.replyCount} 条`:""}</p>{pending&&<p>回复尚待补全，可更新内容或在下次同步继续。</p>}{limited&&<p>{post.threadError||"X 本次未返回更多可访问的回复"}，可更新内容重试。</p>}</footer>}</div>;
}
