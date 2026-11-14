export type PdfMode = "all" | "hits";
export const PDF_ZOOM_MIN = 50;
export const PDF_ZOOM_MAX = 300;
export function validPdfPages(pages: number[], total: number): number[] {
  return [...new Set(pages.filter(p => Number.isInteger(p) && p >= 1 && p <= total))].sort((a,b)=>a-b);
}
export function parsePdfPage(value: string, total: number): {page?: number; error?: string} {
  if (!/^\d+$/.test(value.trim())) return {error:"请输入整数页码。"};
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > total) return {error:`页码范围是 1–${total}。`};
  return {page};
}
export function closestPdfHit(page: number, hits: number[]): number | undefined {
  return hits.find(p=>p>=page) ?? hits[hits.length - 1];
}
export function adjacentPdfPage(page: number, total: number, hits: number[], mode: PdfMode, direction: -1|1): number | undefined {
  if(mode==="all") {const next=page+direction;return next>=1&&next<=total?next:undefined;}
  return direction===1?hits.find(p=>p>page):[...hits].reverse().find(p=>p<page);
}
export function pdfZoomStep(zoom: number, direction: -1|1): number {
  return Math.min(PDF_ZOOM_MAX,Math.max(PDF_ZOOM_MIN,zoom+direction*25));
}

export function isPdfContent(type: string | undefined): boolean { return ["pdf_page", "pdf_ocr", "pdf_attachment"].includes(type ?? ""); }
