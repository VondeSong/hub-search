import React from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/CollectionsWorkspace.css";
import "../src/CollectionSyncPanel.css";
import { DidaReadingResolutions } from "../src/DidaReadingResolutions";

const items = [
  { key: "fixture:one", title: "虽然这么说很糟糕，但默认状态是沉重、无力和贫穷。", snapshot: "version-one", error: "滴答没有返回附件列表，暂时保留原内容", reasonKind: "attachment-list-unavailable", state: "pending", updatedAt: 123, sourceUrl: "https://dida365.com/webapp/#p/fixture/tasks/one" },
  { key: "fixture:two", title: "[你是在那一刻，突然意识到一直困惑的一件事，也许根本不是那么回事了？](https://mp.weixin.qq.com/s?long=" + "query".repeat(40) + ")", snapshot: "version-two", error: "用户选择保留两边内容，已结束自动清理", state: "preserved", updatedAt: 123, sourceUrl: "https://dida365.com/webapp/#p/fixture/tasks/two" },
  { key: "fixture:three", title: "[善待自己](https://mp.weixin.qq.com/s?long=" + "query".repeat(40) + ")", snapshot: "version-three", error: "用户选择保留两边内容，已结束自动清理", state: "preserved", updatedAt: 123, sourceUrl: "https://dida365.com/webapp/#p/fixture/tasks/three" },
  { key: "fixture:four", title: "[Be water,my friend](https://mp.weixin.qq.com/s?long=" + "query".repeat(40) + ")", snapshot: "version-four", error: "用户选择保留两边内容，已结束自动清理", state: "preserved", updatedAt: 123, sourceUrl: "https://dida365.com/webapp/#p/fixture/tasks/four" },
];
const fixture = {
  calls: [] as { command: string; args: any }[], events: [] as string[],
  async invoke(command: string, args: any = {}) {
    fixture.calls.push({ command, args });
    if (command === "list_dida_reading_resolutions") return structuredClone(items);
    if (command === "resolve_dida_reading") {
      const item = items.find(item => item.key === args.key)!;
      if (item.snapshot !== args.snapshot || item.error !== args.error || item.updatedAt !== args.updatedAt) throw "这条内容的处理状态已变化，请刷新后重新选择";
      item.state = args.preserve ? "preserved" : "pending";
      item.error = args.preserve ? "用户选择保留两边内容，已结束自动清理" : "用户要求重新读取检查";
      item.updatedAt += 1;
      return undefined;
    }
    throw new Error("Unexpected mocked IPC: " + command);
  },
};
Object.assign(window, { __DIDA_RETENTION_FIXTURE__: fixture, __TAURI_INTERNALS__: { invoke: fixture.invoke } });
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<div className="collections-workspace"><section className="collection-sync-popover" style={{ inset: "16px auto auto 16px", width: "min(680px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)" }}><header className="collection-sync-panel-header"><strong>同步与连接</strong></header><div className="collection-sync-panel-body"><article className="collection-sync-source-card dida"><div className="collection-sync-source-heading"><strong>滴答稍后读</strong><span>已连接</span></div><DidaReadingResolutions busy={false} onRetry={() => fixture.events.push("retry")} onOpenUrl={url => fixture.events.push(url)} pendingCount={1} preservedCount={3}/></article></div></section></div>);
