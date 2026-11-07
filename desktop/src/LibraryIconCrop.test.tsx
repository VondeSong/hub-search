// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { iconCropRect, LibraryIconCrop } from "./LibraryIconCrop";
import { SettingsDialog } from "./SettingsDialog";

afterEach(()=>vi.restoreAllMocks());
it("keeps every drag and zoom crop within a landscape or portrait image",()=>{
  for(const [width,height] of [[1200,600],[600,1200],[512,512]]) for(const zoom of [1,1.3,4,9]) for(const x of [-3,-1,0,1,3]) for(const y of [-3,-1,0,1,3]){
    const crop=iconCropRect(width,height,zoom,x,y);
    expect(crop.sx).toBeGreaterThanOrEqual(0);expect(crop.sy).toBeGreaterThanOrEqual(0);
    expect(crop.sx+crop.side).toBeLessThanOrEqual(width);expect(crop.sy+crop.side).toBeLessThanOrEqual(height);
  }
  expect(iconCropRect(1200,600,1,0,0)).toEqual({sx:300,sy:0,side:600});
  expect(iconCropRect(1200,600,2,1,-1)).toEqual({sx:0,sy:300,side:300});
});
it("only saves the cropped pixels and keeps failed saves editable",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}disconnect(){}}});
  Object.defineProperty(HTMLDialogElement.prototype,"showModal",{value:vi.fn(),configurable:true});
  const drawImage=vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/png;base64,cropped");
  const container=document.createElement("div");document.body.appendChild(container);const root=createRoot(container);
  const save=vi.fn(async()=>{throw new Error("保存失败");}),cancel=vi.fn();
  try{
    await act(async()=>root.render(<LibraryIconCrop source="data:image/png;base64,original" name="Main" onSave={save} onCancel={cancel}/>));
    const img=container.querySelector("img")!;Object.defineProperties(img,{naturalWidth:{value:1200},naturalHeight:{value:600}});
    await act(async()=>img.dispatchEvent(new Event("load")));
    const button=[...container.querySelectorAll("button")].find(b=>b.textContent==="保存图标")!;
    await act(async()=>button.click());
    expect(drawImage).toHaveBeenCalledWith(img,300,0,600,600,0,0,256,256);
    expect(save).toHaveBeenCalledWith("data:image/png;base64,cropped");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("保存失败");
    expect(button.disabled).toBe(false);
    await act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="取消")!.click());
    expect(cancel).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledOnce();
  }finally{await act(async()=>root.unmount());container.remove();}
});
it("opens cropping inside settings without the old settings focus trap stealing focus", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLButtonElement>("button")?.focus();
  }) });
  function Harness() {
    const [cropping, setCropping] = useState(false);
    return <SettingsDialog canClose={!cropping} externalModalOpen={cropping} category="libraries" onCategoryChange={() => undefined} onClose={() => undefined}>
      <button onClick={() => setCropping(true)}>开始裁剪</button>
      {cropping && <LibraryIconCrop source="data:image/png;base64,original" name="Main" onSave={async () => undefined} onCancel={() => setCropping(false)} />}
    </SettingsDialog>;
  }
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "开始裁剪")!.click());
    const crop = container.querySelector<HTMLDialogElement>(".library-icon-crop-dialog")!;
    expect(crop.open).toBe(true);
    expect(crop.closest('[role="dialog"]')).not.toBeNull();
    expect(crop.contains(document.activeElement)).toBe(true);
    expect(crop.inert).not.toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
it("does not reopen an already modal crop dialog during a strict effect replay", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
  const showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<StrictMode><LibraryIconCrop source="data:image/png;base64,original" name="Main" onSave={async () => undefined} onCancel={() => undefined} /></StrictMode>));
    expect(showModal).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
