import { expect, it } from "vitest";
import { appDomainViolations, readAppDomainSource } from "../qa/check-app-domain-ownership.mjs";

it("rejects restored domain state and accepts neighboring local UI state", () => {
  expect(appDomainViolations('import {useState as state} from "react"; function App(){const [spaces,setSpaces]=state([]);}', false).map(item => item.rule)).toContain("domain-state");
  expect(appDomainViolations('import {useState as state} from "react"; function App(){const [spaceMenuOpen,setSpaceMenuOpen]=state(false);}', false)).toEqual([]);
});
it("detects aliased typed domain state while permitting preview UI history", () => {
  expect(appDomainViolations('import * as React from "react"; function App(){const [temporary]=React.useState<LibrarySummary[]>([]);}', false).map(item => item.rule)).toContain("domain-state");
  expect(appDomainViolations('import * as React from "react"; function App(){const [previewNavigation]=React.useState(EMPTY_PREVIEW_NAVIGATION);}', false)).toEqual([]);
});
it("rejects migrated persistence keys without treating comments or presentation labels as producers", () => {
  expect(appDomainViolations('const key="craft-search-filters-v1"; function App(){}', false).map(item => item.rule)).toContain("domain-persistence");
  expect(appDomainViolations('// craft-search-filters-v1\nfunction App(){const label="资料库";}', false)).toEqual([]);
});
it("detects native producers through imported and local aliases and permits owner intent calls", () => {
  expect(appDomainViolations('import {invoke as request} from "@tauri-apps/api/core"; function App(){const call=request;call("list_libraries");}', false).map(item => item.rule)).toContain("native-producer");
  expect(appDomainViolations('function App(){const submit=()=>selectOnlyLibrary("a");}', false)).toEqual([]);
  expect(appDomainViolations('function App(){const invoke=()=>selectOnlyLibrary("a");invoke();}', false)).toEqual([]);
});
it("enforces exactly one shared management collaborator in the actual App assembly", () => {
  const source = readAppDomainSource();
  expect(appDomainViolations(source)).toEqual([]);
  const duplicate = source.replace("function App() {", "function App() { useLibraryManagement(false, async()=>{});");
  expect(appDomainViolations(duplicate).filter(item => item.rule === "owner-identity").map(item => item.detail)).toEqual(["useLibraryManagement must have exactly one instance; found 2"]);
});
it("follows provider wrappers and counts each rendered local component instance", () => {
  const source = 'function Body(){useLibraryManagement(false,async()=>{});const [spaces,setSpaces]=useState([]);} function App(){return <Provider><Body/><Body/></Provider>}';
  const issues = appDomainViolations(source);
  expect(issues.filter(item => item.rule === "owner-identity" && item.detail.startsWith("useLibraryManagement ")).map(item => item.detail)).toEqual(["useLibraryManagement must have exactly one instance; found 2"]);
  expect(issues.filter(item => item.rule === "domain-state")).toHaveLength(2);
  expect(appDomainViolations('function App(){return <App/>}').some(item => item.rule === "assembly-cycle")).toBe(true);
});
