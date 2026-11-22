import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CollectionAttachment } from "./CollectionAttachment";
export type CollectionPost={source?:string;origin?:{name:string;url:string};id:string;text:string;authorName:string;authorHandle:string;publishedAt:string;url:string;quotedText:string;contentStatus:string;links:string[];media:{kind:string;url:string;previewUrl?:string}[];quote?:CollectionPost|null;quoteId?:string;thread?:CollectionPost[];allMedia?:CollectionPost["media"];threadStatus?:string;replyToId?:string;replyToHandle?:string;replyCount?:number;threadFormat?:number;threadError?:string};
export const collectionAttachments=(post:CollectionPost)=>post.allMedia?.length?post.allMedia:post.media;
function timestamp(value:string) {
 const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleString(undefined,{year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
// Only identical URLs are shared assets; separately uploaded versions remain distinct.
function visibleMedia(post:CollectionPost,seen:Set<string>,depth=0):CollectionPost {
 const media=post.media.filter((asset,index)=>{const key=asset.url||asset.previewUrl||`${post.id}:${index}`;if(seen.has(key))return false;seen.add(key);return true;});
 return {...post,media,quote:post.quote&&depth<5?visibleMedia(post.quote,seen,depth+1):post.quote};
}
function Text({text,open}:{text:string;open:(url:string)=>Promise<void>}) {
 return <div className="collection-post-text"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({href,children})=><a className="preview-text-link" href={href} onClick={event=>{event.preventDefault();if(href)void open(href);}}>{children}</a>,img:({alt})=><span>{alt}</span>}}>{text}</ReactMarkdown></div>;
}
function Body({post,itemKey,open,depth=0,attachmentSummary}:{post:CollectionPost;itemKey:string;open:(url:string)=>Promise<void>;depth?:number;attachmentSummary?:ReactNode}) {
 return <>{post.origin&&<p className="collection-origin">转发自 {post.origin.url?<a className="preview-text-link" href={post.origin.url} onClick={e=>{e.preventDefault();void open(post.origin!.url);}}>{post.origin.name||"原始消息"}</a>:post.origin.name||"原始消息"}</p>}<>{post.source==="web"?<pre className="collection-public-snapshot">{post.text}</pre>:<Text text={post.text} open={open}/>}</>
 {attachmentSummary}
 {!!post.media.length&&<div className="collection-own-media">{post.quote&&<small className="collection-media-source">本帖附件</small>}<div className="collection-media">{post.media.map((media,index)=><CollectionAttachment key={`${media.url}:${index}`} media={media} itemKey={itemKey}/>)}</div></div>}
 {!!post.links.length&&<div className="collection-detail-links">{post.links.filter(url=>!post.text.includes(url)).map(url=><a className="preview-text-link" key={url} href={url} onClick={event=>{event.preventDefault();void open(url);}}>{url}</a>)}</div>}
 {post.quote&&depth<5?<blockquote className="collection-quote" aria-label="引用原帖"><header><a className="preview-text-link" href={post.quote.url} onClick={event=>{event.preventDefault();void open(post.quote!.url);}}>引用原帖 · {post.quote.authorName} @{post.quote.authorHandle}</a><time dateTime={post.quote.publishedAt}>{timestamp(post.quote.publishedAt)}</time></header><Body post={post.quote} itemKey={itemKey} open={open} depth={depth+1}/></blockquote>:post.quotedText?<blockquote><Text text={post.quotedText} open={open}/></blockquote>:post.quoteId?<p className="collections-note"><a className="preview-text-link" href={`https://x.com/i/status/${post.quoteId}`} onClick={event=>{event.preventDefault();void open(`https://x.com/i/status/${post.quoteId}`);}}>引用原帖</a> · 引用内容暂不可用</p>:null}
 {post.contentStatus==="partial"&&<p className="collections-note">正文可能不完整，请打开原文查看。</p>}</>;
}
export function CollectionPostBody({post,itemKey,open,attachmentSummary}:{post:CollectionPost;itemKey:string;open:(url:string)=>Promise<void>;revision?:string;attachmentSummary?:ReactNode}) {
 const parts=[post,...(post.thread||[])].sort((a,b)=>a.id.length-b.id.length||a.id.localeCompare(b.id));
 const seen=new Set<string>();const visible=parts.map(part=>visibleMedia(part,seen));
 const replies=post.thread?.length||0;
 const pending=["pending","partial"].includes(post.threadStatus||"")||((post.threadFormat||0)<2&&(post.replyCount||0)>0);
 const limited=post.threadStatus==="limited";
 return <div className="collection-posts">{visible.map((part,index)=><section className={index?"collection-thread-part":"collection-main-post"} key={part.id}>
 {parts.length>1&&<header className="collection-thread-source"><a className="preview-text-link" href={part.url} onClick={event=>{event.preventDefault();void open(part.url);}}>{part.authorName} @{part.authorHandle}</a><time dateTime={part.publishedAt}>{timestamp(part.publishedAt)}</time>{part.replyToId&&part.replyToId!==post.id&&<a className="preview-text-link collection-reply-to" href={`https://x.com/i/status/${part.replyToId}`} onClick={event=>{event.preventDefault();void open(`https://x.com/i/status/${part.replyToId}`);}}>回复 {part.replyToHandle?`@${part.replyToHandle}`:parts.find(parent=>parent.id===part.replyToId)?.authorName||"原帖"}</a>}</header>}
 <Body post={part} itemKey={itemKey} open={open} attachmentSummary={part.id===post.id?attachmentSummary:undefined}/></section>)}
 {(replies>0||pending||limited)&&<footer className="collection-replies-summary"><p>已获取 {replies} 条回复{typeof post.replyCount==="number"?` · X 显示 ${post.replyCount} 条`:""}</p>{pending&&<p>回复尚待补全，可更新内容或在下次同步继续。</p>}{limited&&<p>{post.threadError||"X 本次未返回更多可访问的回复"}，可更新内容重试。</p>}</footer>}</div>;
}
