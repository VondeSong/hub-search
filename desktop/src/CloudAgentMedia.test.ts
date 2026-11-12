// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { sampleTimes, uploadSize, videoUploads } from "./CloudAgentMedia";

describe("Agents media limits", () => {
  it("selects ordered times inside the short video and respects the attachment budget", () => {
    expect(sampleTimes(3, 6)).toEqual([0.5, 1.5, 2.5]);
    expect(sampleTimes(12, 2)).toEqual([3, 9]);
    expect(sampleTimes(31, 6)).toEqual([]);
    expect(sampleTimes(5, 0)).toEqual([]);
  });

  it("counts decoded bytes including base64 padding", () => {
    expect(uploadSize([
      { name: "a.png", mime: "image/png", data: "YQ==" },
      { name: "b.jpg", mime: "image/jpeg", data: "YWI=" },
    ])).toBe(3);
  });

  it("captures a presented frame after seeking and labels its actual timestamp", async () => {
    const create = document.createElement.bind(document);
    const video = create("video");
    const drawImage = vi.fn();
    let callback: VideoFrameRequestCallback | undefined;
    let seeking = false;
    Object.defineProperties(video, {
      duration: { value: 1 }, videoWidth: { value: 32 }, videoHeight: { value: 32 },
      seeking: { get: () => seeking },
      src: { set: () => queueMicrotask(() => video.dispatchEvent(new Event("loadeddata"))) },
      currentTime: { set: () => { seeking = true; video.dispatchEvent(new Event("seeked")); } },
    });
    video.requestVideoFrameCallback = vi.fn(next => { callback = next; return 1; });
    video.cancelVideoFrameCallback = vi.fn();
    video.load = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: revoke });
    const canvas = create("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toBlob").mockImplementation(done => done(new Blob(["frame"], { type: "image/jpeg" })));
    const elements = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => tag === "video" ? video : tag === "canvas" ? canvas : create(tag)) as typeof document.createElement);
    try {
      const pending = videoUploads(new File(["video"], "test.mp4", { type: "video/mp4" }), 1);
      await vi.waitFor(() => expect(callback).toBeDefined());
      expect(drawImage).not.toHaveBeenCalled();
      callback!(0, { mediaTime: 0 } as VideoFrameCallbackMetadata);
      expect(drawImage).not.toHaveBeenCalled();
      seeking = false;
      callback!(1, { mediaTime: 0.48 } as VideoFrameCallbackMetadata);
      const frames = await pending;
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(frames[0].seconds).toBe(0.48);
      expect(frames[0].mime).toBe("image/jpeg");
      expect(revoke).toHaveBeenCalledWith("blob:test");
    } finally { elements.mockRestore(); vi.unstubAllGlobals(); }
  });
});
