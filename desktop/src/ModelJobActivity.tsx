import { cancelModelJob, publishCodexNotice, useCodexSuite, type CodexJob } from "./CodexSuite";
import "./ModelJobActivity.css";

export function ModelJobActivity({ job }: { job: CodexJob }) {
  if (!job.progress?.length) return null;
  const active = job.state === "running" || job.state === "queued";
  return <details className="model-job-activity">
    <summary>工作过程 · {active ? job.progress[job.progress.length - 1].message : job.state === "succeeded" ? "本轮结束" : job.state === "cancelled" ? "已停止" : "未完成"}</summary>
    <ol>{job.progress.map((step, index) => <li key={index}><time>{new Date(step.at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>{step.message}</span></li>)}</ol>
    <small>记录实际处理步骤；具体依据和建议见结果。生成结束后仍需审核。</small>
  </details>;
}

export function TagTaskActivity({ tag, workflows }: { tag: string; workflows: string[] }) {
  const suite = useCodexSuite();
  const job = [...suite.jobs].reverse().find(item => workflows.includes(item.workflow) && item.context === tag);
  if (!job) return null;
  return <div className="tag-task-activity">
    <ModelJobActivity key={job.id} job={job}/>
    {job.error && <p role="status">{job.error}</p>}
    {(job.state === "running" || job.state === "queued") && <button type="button" onClick={() => void cancelModelJob(job.id).catch(reason => publishCodexNotice(String(reason), "error"))}>停止本次处理</button>}
  </div>;
}
