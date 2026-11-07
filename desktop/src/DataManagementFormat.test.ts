import { expect, it } from "vitest";
import { formatDataPath, isInDataDirectory } from "./DataManagementFormat";

it("shows ordinary Windows drive and network paths without changing other path forms", () => {
  expect(formatDataPath(String.raw`\\?\C:\Users\name\Hub 数据`)).toBe(String.raw`C:\Users\name\Hub 数据`);
  expect(formatDataPath(String.raw`\\?\UNC\server\share\Hub`)).toBe(String.raw`\\server\share\Hub`);
  for (const path of ["/home/name/Hub", "D:/Hub Data", String.raw`\\server\share\Hub`, String.raw`\\?\Volume{123}\Hub`]) {
    expect(formatDataPath(path)).toBe(path);
  }
});

it("classifies contained files across Windows prefixes and case without accepting sibling or parent paths", () => {
  expect(isInDataDirectory(String.raw`\\?\c:\HUB\external-sources\xv`, "C:/Hub")).toBe(true);
  expect(isInDataDirectory(String.raw`\\?\UNC\SERVER\share\Hub\xv`, String.raw`\\server\share\Hub`)).toBe(true);
  expect(isInDataDirectory("C:/Hub-other/xv", "C:/Hub")).toBe(false);
  expect(isInDataDirectory("C:/Hub/../outside", "C:/Hub")).toBe(false);
  expect(isInDataDirectory("/notes/hub/xv", "/notes/Hub")).toBe(false);
});
