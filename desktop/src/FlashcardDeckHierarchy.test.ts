import { expect, it } from "vitest";
import { buildDeckHierarchy } from "./FlashcardDeckHierarchy";
import type { FlashcardDeckSummary } from "./FlashcardTypes";
const deck=(id:string,parentDeckId="",folderId=""):FlashcardDeckSummary=>({id,name:id,parentDeckId,folderId,cardCount:1,dueCount:1,newCount:0,updatedAt:1});
it("keeps every descendant, unrelated deck and unresolved parent exactly once",()=>{
  const tree=buildDeckHierarchy([deck("child","root"),deck("orphan","late"),deck("root"),deck("grandchild","child"),deck("other")]);
  expect([...tree.descendants("root")].sort()).toEqual(["child","grandchild","root"]);
  expect(tree.children.get("")?.map(deck=>deck.id)).toEqual(["orphan","other","root"]);
  expect(tree.parentById.get("orphan")).toBe("");
});
it("projects malformed cycles deterministically without dropping their cards' decks",()=>{
  const tree=buildDeckHierarchy([deck("b","a"),deck("a","b"),deck("self","self")]);
  expect(tree.parentById.get("a")).toBe("");
  expect([...tree.descendants("a")].sort()).toEqual(["a","b"]);
  expect(tree.parentById.get("self")).toBe("");
});
it("places a tree in the root folder even if a late child record has a stale folder",()=>{
  const tree=buildDeckHierarchy([deck("root","","folder"),deck("child","root","stale")]);
  expect(tree.rootsByFolder.get("folder")?.map(d=>d.id)).toEqual(["root"]);
  expect(tree.rootsByFolder.has("stale")).toBe(false);
});
it("handles a 12001-deck chain iteratively without a fixed depth or result cap",()=>{
  const decks=Array.from({length:12001},(_,i)=>deck(`d${i}`,i?`d${i-1}`:""));
  const tree=buildDeckHierarchy(decks.reverse());
  expect(tree.descendants("d0").size).toBe(12001);
  expect(tree.byId.size).toBe(12001);
});
