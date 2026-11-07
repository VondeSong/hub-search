// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadAgentModelPreference, loadAgentPreferences, rememberAgentModelPreference, rememberAgentPreferences } from "./AgentPreferences";
beforeEach(()=>localStorage.clear());
afterEach(()=>vi.restoreAllMocks());
it("starts new chats with live search and no inherited grants",()=>{
 expect(loadAgentPreferences()).toEqual({model:null,autoFlashcardInbox:false,webSearch:"live"});
});
it("remembers model effort and fast mode but never carries saving or tool grants",()=>{
 const model={provider:"codex" as const,model:"model-a",reasoningEffort:"high",fast:true,maxConcurrent:2};
 rememberAgentPreferences({model,webSearch:"disabled",autoFlashcardInbox:true,externalMcp:true});
 expect(loadAgentPreferences()).toEqual({model,webSearch:"disabled",autoFlashcardInbox:false});
 rememberAgentPreferences({model:null,webSearch:"cached",autoFlashcardInbox:false});
 expect(loadAgentPreferences()).toEqual({model:null,webSearch:"cached",autoFlashcardInbox:false});
});
it("ignores malformed saved preferences",()=>{
 localStorage.setItem("hub.agent.preferences.v1",'{"model":{"provider":"other"},"webSearch":"other"}');
 expect(loadAgentPreferences()).toEqual({model:null,autoFlashcardInbox:false,webSearch:"live"});
 localStorage.setItem("hub.agent.preferences.v1","broken");
 expect(loadAgentPreferences().model).toBeNull();
});
it("keeps effort preferences separate by provider and never gives DeepSeek Fast",()=>{
 rememberAgentModelPreference({provider:"codex",model:"same-id",reasoningEffort:"high",fast:true,maxConcurrent:2});
 rememberAgentModelPreference({provider:"deepseek",model:"same-id",reasoningEffort:"none",fast:true,maxConcurrent:2});
 expect(loadAgentModelPreference("codex","same-id")).toEqual({reasoningEffort:"high",fast:true});
 expect(loadAgentModelPreference("deepseek","same-id")).toEqual({reasoningEffort:"none",fast:false});
 expect(loadAgentPreferences()).toEqual({model:null,autoFlashcardInbox:false,webSearch:"live"});
});
it("ignores malformed per-model preferences and tolerates unavailable storage",()=>{
 localStorage.setItem("hub.agent.model-preferences.v1",JSON.stringify([{provider:"other",model:"a",reasoningEffort:"high",fast:true},{provider:"codex",model:"a",reasoningEffort:{value:"high"},fast:false}]));
 expect(loadAgentModelPreference("codex","a")).toBeNull();
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("QuotaExceededError");});
 expect(()=>rememberAgentPreferences({model:{provider:"codex",model:"a",reasoningEffort:"high",fast:true,maxConcurrent:2},autoFlashcardInbox:false})).not.toThrow();
});
