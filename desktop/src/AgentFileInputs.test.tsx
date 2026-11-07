// @vitest-environment jsdom
import {expect,it} from "vitest";
import {readTextFile,prepareImage} from "./AgentFileInputs";
it("reads a UTF-8 text attachment without losing its content",async()=>{
 expect(await readTextFile(new File(["标题\n实际资料"],"资料.md",{type:"text/markdown"}))).toBe("标题\n实际资料");
});
it("accepts a long document independently of the message length",async()=>{const body="长文段落\n".repeat(10_000);expect(await readTextFile(new File([body],"长文.txt"))).toBe(body);});
it("rejects unsupported, binary, invalid encoding and oversized text rather than silently truncating",async()=>{
 for(const file of [new File(["pdf"],"a.pdf"),new File(["a\0b"],"a.txt"),new File([new Uint8Array([255,254])],"a.txt"),new File(["字".repeat(500001)],"a.md")])await expect(readTextFile(file)).rejects.toThrow();
});
it("rejects oversized images before browser decoding",async()=>{
 await expect(prepareImage(new File([new Uint8Array(20*1024*1024+1)],"a.png",{type:"image/png"}))).rejects.toThrow("20 MiB");
});
