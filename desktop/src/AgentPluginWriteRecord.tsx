import type {PluginWriteAction} from "./AgentActionTypes";
export function AgentPluginWriteRecord({item,disabled,revoked,onAction}:{item:PluginWriteAction;disabled:boolean;revoked:boolean;onAction:(args:Record<string,unknown>)=>Promise<void>}) {
  const states:Record<string,string>={prepared:"待确认",executing:"正在执行或核对",unknown:"结果待核对",verified:"评论已回读核验",expired:"草稿已失效"};
  const target=item.payload?.targetUrl;
  const safe=(url?:string)=>!!url&&/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/issues\/\d+(?:#issuecomment-\d+)?$/.test(url);
  return <details open className="agent-action-record"><summary>GitHub 评论 · {states[item.state]||item.state}</summary>
    {item.payload&&<><p>{safe(target)?<a href={target} target="_blank" rel="noreferrer">{item.payload.targetTitle}</a>:item.payload.targetTitle}</p><p className="agent-note">{item.payload.arguments.repo_full_name} · #{item.payload.arguments.pr_number}</p><div className="agent-action-text">{item.payload.arguments.comment}</div></>}
    {item.state==="prepared"&&<><p className="agent-note">发布到上面的 Issue。账号、仓库与正文已绑定；确认后执行并回读，不代表整个事项目标已经完成。</p><button type="button" disabled={disabled||revoked||!item.confirmationToken} onClick={()=>void onAction({action:"submitPluginWrite",actionId:item.id,confirmationToken:item.confirmationToken})}>确认发布这条评论</button></>}
    {item.state==="unknown"&&<><p className="agent-note">远端可能已收到评论。这里只核对已有结果，不重新发布。</p><button type="button" disabled={disabled||revoked||!item.confirmationToken} onClick={()=>void onAction({action:"inspectPluginWrite",actionId:item.id,confirmationToken:item.confirmationToken})}>核对已有评论</button></>}
    {item.receipt?.verified&&safe(item.receipt.url)&&<p><a href={item.receipt.url} target="_blank" rel="noreferrer">查看已核验的评论</a></p>}
    {item.error&&<p className="agent-notice">{item.error}</p>}
  </details>;
}
