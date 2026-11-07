// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { beforeEach,afterEach,it,expect } from "vitest";
import { FlashcardDeckTree } from "./FlashcardDeckTree";
import type { FlashcardDeckSummary } from "./FlashcardTypes";
const decks:FlashcardDeckSummary[]=[{id:"root",name:"Parent",folderId:"",cardCount:1,dueCount:1,newCount:0,updatedAt:1},{id:"child",name:"Child",parentDeckId:"root",folderId:"",cardCount:1,dueCount:1,newCount:0,updatedAt:1}];
let host:HTMLDivElement,root:Root;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
async function render(selectedDeckId="",search=""){await act(async()=>root.render(<FlashcardDeckTree decks={decks} folderId="" selectedDeckId={selectedDeckId} search={search} renderRow={deck=><button>{deck.name}</button>}/>));}
it("collapses and persists a parent while revealing a selected descendant",async()=>{
  await render(); expect(host.textContent).toContain("Child");
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-expanded="true"]')!.click());
  expect(host.textContent).not.toContain("Child");
  expect(JSON.parse(localStorage.getItem("hub.flashcards.subdeck-expansion-v1.")!)).toEqual(["root"]);
  await render("child");expect(host.textContent).toContain("Child");
});
it("shows the full ancestor path for a matching hidden descendant",async()=>{
  localStorage.setItem("hub.flashcards.subdeck-expansion-v1.",JSON.stringify(["root"]));
  await render("","child");expect(host.textContent).toContain("Parent");expect(host.textContent).toContain("Child");
});
