// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadAgentPreferences, rememberAgentPreferences } from "./AgentPreferences";
beforeEach(()=>localStorage.clear());
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
