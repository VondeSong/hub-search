// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { cachedCodexSuiteModels, codexSelectionLabel, loadCodexSuiteModels, resetCodexSuiteForTests } from "./CodexSuite";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
beforeEach(()=>{resetCodexSuiteForTests();invoke.mockReset();vi.useRealTimers();});
const models=[{id:"actual",name:"实际模型"}];
it("shares pending and successful directories only within the same provider",async()=>{
 let finish!:(value:{models:typeof models})=>void;
 invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const a=loadCodexSuiteModels("codex"),b=loadCodexSuiteModels("codex");expect(a).toBe(b);
 finish({models});await a;await loadCodexSuiteModels("codex");expect(invoke).toHaveBeenCalledTimes(1);
 invoke.mockResolvedValueOnce({models:[{id:"other",name:"其他"}]});await loadCodexSuiteModels("deepseek");
 expect(cachedCodexSuiteModels("codex")).toEqual(models);expect(cachedCodexSuiteModels("deepseek")?.[0].id).toBe("other");
});
it("retains a successful directory on refresh failure and allows an explicit retry",async()=>{
 invoke.mockResolvedValueOnce({models});await loadCodexSuiteModels("codex");
 invoke.mockRejectedValueOnce(new Error("offline"));await expect(loadCodexSuiteModels("codex",true)).rejects.toThrow("offline");
 expect(cachedCodexSuiteModels("codex")).toEqual(models);
 invoke.mockResolvedValueOnce({models:[]});expect(await loadCodexSuiteModels("codex",true)).toEqual([]);
 expect(cachedCodexSuiteModels("codex")).toEqual([]);
});
it("refreshes expired entries without discarding the last visible directory",async()=>{
 const now=vi.spyOn(Date,"now").mockReturnValue(0);invoke.mockResolvedValue({models});await loadCodexSuiteModels("codex");
 now.mockReturnValue(300_001);const request=loadCodexSuiteModels("codex");expect(cachedCodexSuiteModels("codex")).toEqual(models);await request;
 expect(invoke).toHaveBeenCalledTimes(2);now.mockRestore();
});
it("rejects malformed catalog replies and never restores a cache cleared by reset",async()=>{
 invoke.mockResolvedValueOnce({});await expect(loadCodexSuiteModels("codex")).rejects.toThrow("目录返回无效");
 let finish!:(value:{models:typeof models})=>void;invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const old=loadCodexSuiteModels("codex");resetCodexSuiteForTests();finish({models});await old;
 expect(cachedCodexSuiteModels("codex")).toBeUndefined();
});
it("omits unsupported speed labels without reinterpreting a historical Fast request",()=>{
 const selected={model:"saved-model",reasoningEffort:"high",fast:false,maxConcurrent:2};
 expect(codexSelectionLabel({...selected,provider:"deepseek"})).toBe("saved-model · 高 · DeepSeek");
 expect(codexSelectionLabel({...selected,provider:"deepseek",fast:true})).toBe("saved-model · 高 · DeepSeek");
 expect(codexSelectionLabel({...selected,provider:"codex"})).toBe("saved-model · 高");
 expect(codexSelectionLabel({...selected,provider:"codex",fast:true})).toBe("saved-model · 高 · Fast");
});
