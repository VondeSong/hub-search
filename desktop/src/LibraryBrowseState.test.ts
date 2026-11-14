import { beforeEach, expect, it, vi } from "vitest";
import { LIBRARY_BROWSE_STATE_KEY, LIBRARY_TOPICS_KEY, loadLibraryBrowseState, loadLibraryTopics, persistLibraryBrowseState, referenceKey, toggleTopicReference, type LibraryReference } from "./LibraryBrowseState";

const values = vi.hoisted(() => new Map<string, string>());
vi.mock("./UserProfileStorage", () => ({userProfileStorage: {getItem: (key: string) => values.get(key) ?? null, setItem: (key:string,value:string) => {values.set(key,value);}}}));
beforeEach(() => values.clear());
const folder: LibraryReference = {kind: "folder", libraryId: "a", folderId: "folder", title: "目录"};

it("keeps references from different libraries distinct and removes only the requested reference", () => {
  const other = {...folder, libraryId: "b"};
  expect(referenceKey(other)).not.toBe(referenceKey(folder));
  expect(toggleTopicReference([folder,other], folder)).toEqual([other]);
  expect(toggleTopicReference([folder], other)).toEqual([folder,other]);
});

it("loads real topic references while rejecting corrupt, duplicate and unknown payloads", () => {
  values.set(LIBRARY_TOPICS_KEY, JSON.stringify([{id:"topic",name:"  样件检查  ",items:[folder,folder,null,{kind:"unknown"}]}, {id:"topic",name:"重复身份",items:[]}, {id:"broken",name:0}]));
  expect(loadLibraryTopics()).toEqual([{id:"topic",name:"样件检查",items:[folder]}]);
  values.set(LIBRARY_TOPICS_KEY, "{");
  expect(loadLibraryTopics()).toEqual([]);
});

it("restores validated view preferences and discards invalid scroll and preview state", () => {
  values.set(LIBRARY_BROWSE_STATE_KEY, JSON.stringify({position:{libraryId:"a",folderId:"folder"},mode:"columns",readerOpen:false,
    expansion:{a:true,b:"false"},positions:{a:"folder",b:0},scroll:{good:{list:120,tree:80,columns:20},bad:{list:-1,tree:0,columns:0}},preview:{id:"invalid"}}));
  expect(loadLibraryBrowseState()).toEqual(expect.objectContaining({position:{libraryId:"a",folderId:"folder"},mode:"columns",readerOpen:false,
    expansion:{a:true},positions:{a:"folder"},scroll:{good:{list:120,tree:80,columns:20}},preview:undefined}));
});

it("persists directory scroll without recording transient search views", () => {
  persistLibraryBrowseState({scroll:{directory:{list:120,tree:0,columns:0},"search:directory":{list:900,tree:0,columns:0}}});
  expect(loadLibraryBrowseState().scroll).toEqual({directory:{list:120,tree:0,columns:0}});
});
