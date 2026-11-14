import {describe,expect,it} from "vitest";
import {adjacentPdfPage,closestPdfHit,parsePdfPage,pdfZoomStep,validPdfPages} from "./PdfPreviewModel";
describe("PDF original-page navigation",()=>{
 it("rejects missing, fractional, unsafe and out-of-range page numbers",()=>{
  for(const value of ["","0","121","3.5","-1","1e2","9007199254740993"]){expect(parsePdfPage(value,120).error).toBeTruthy();}
  expect(parsePdfPage(" 110 ",120)).toEqual({page:110});
 });
 it("keeps hit sequence separate from document page numbers",()=>{
  const hits=validPdfPages([110,14,2,14,0,121],120);expect(hits).toEqual([2,14,110]);
  expect(adjacentPdfPage(14,120,hits,"hits",1)).toBe(110);
  expect(adjacentPdfPage(14,120,hits,"all",1)).toBe(15);
  expect(closestPdfHit(20,hits)).toBe(110);expect(closestPdfHit(120,hits)).toBe(110);
  expect(adjacentPdfPage(110,120,hits,"hits",1)).toBeUndefined();
  expect(adjacentPdfPage(1,1,[1],"all",1)).toBeUndefined();
 });
 it("bounds display zoom independently of page rendering",()=>{
  expect(pdfZoomStep(50,-1)).toBe(50);expect(pdfZoomStep(300,1)).toBe(300);expect(pdfZoomStep(100,1)).toBe(125);
 });
});
