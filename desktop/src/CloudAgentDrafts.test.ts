import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { composerDraftKey, flushComposerDrafts, loadComposerDrafts, saveComposerDraft, type ComposerDraft } from "./CloudAgentDrafts";
import { outbox, type DraftTurn } from "./CloudAgentMedia";
import { openCloudAgentLocalStorage } from "./CloudAgentLocalStorage";

const draft = (text: string): ComposerDraft => ({ text, attachments: [], skillVersion: "", skillPaths: [] });
const turn = (id: string): DraftTurn => ({ thread: "thread", turn: id, text: "已点击发送的问题", attachments: [], created: 1 });
beforeEach(async () => { await flushComposerDrafts(); globalThis.indexedDB = new IDBFactory(); });

it("reopens separate drafts with their images/material/model and isolates device bindings", async () => {
  const full = { ...draft("请核对报告"), attachments: [{ name: "原图.png", mime: "image/png", data: "YQ==" }], material: { id: "doc", title: "资料", source: "local", text: "原文", sha256: "sha" }, selection: { model: "model", effort: "low" } };
  await Promise.all([saveComposerDraft("device", "thread", full), saveComposerDraft("device", "new", draft("另一个问题")), saveComposerDraft("other", "thread", draft("其他连接"))]);
  expect(await loadComposerDrafts("device")).toEqual(new Map([["new", draft("另一个问题")], ["thread", full]]));
  expect(await loadComposerDrafts("other")).toEqual(new Map([["thread", draft("其他连接")]]));
  expect(await outbox("device")).toBeUndefined();
});

it("serializes edits and deletes only an explicitly emptied draft", async () => {
  await Promise.all([saveComposerDraft("device", "one", draft("旧内容")), saveComposerDraft("device", "one", draft("最新内容")), saveComposerDraft("device", "two", draft("保留"))]);
  expect((await loadComposerDrafts("device")).get("one")?.text).toBe("最新内容");
  await saveComposerDraft("device", "one", draft(""));
  expect(await loadComposerDrafts("device")).toEqual(new Map([["two", draft("保留")]]));
});

it("atomically hands the composer to the outbox without reviving an already sent question", async () => {
  const saving = saveComposerDraft("device", "thread", draft("请核对报告"));
  await outbox("device", turn("first"), undefined, "thread");
  await saving;
  expect(await loadComposerDrafts("device")).toEqual(new Map());
  expect(await outbox("device")).toEqual(turn("first"));
  await outbox("device", null, "unrelated");
  expect(await outbox("device")).toEqual(turn("first"));
  await outbox("device", null, "first");
  expect(await outbox("device")).toBeUndefined();
});

it("keeps both drafts and the original pending turn when a second send conflicts", async () => {
  await outbox("device", turn("first"));
  await saveComposerDraft("device", "thread", draft("不覆盖旧请求"));
  await expect(outbox("device", turn("second"), undefined, "thread")).rejects.toThrow("另有一条消息待确认");
  expect(await outbox("device")).toEqual(turn("first"));
  expect((await loadComposerDrafts("device")).get("thread")?.text).toBe("不覆盖旧请求");
});

it("reports an unreadable draft without deleting it or a historical outbox", async () => {
  const db = await openCloudAgentLocalStorage();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("pending", "readwrite");
    tx.objectStore("pending").put({ text: 123 }, composerDraftKey("device", "thread"));
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
  await outbox("device", turn("first"));
  await expect(loadComposerDrafts("device")).rejects.toThrow("原数据已保留");
  expect(await outbox("device")).toEqual(turn("first"));
  await expect(loadComposerDrafts("device")).rejects.toThrow();
});
