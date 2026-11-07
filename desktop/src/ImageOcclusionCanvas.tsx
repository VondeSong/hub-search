import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { FlashcardOcclusion } from "./FlashcardTypes";

type Point = { x: number; y: number };

type Props = {
  imageUrl: string;
  occlusions: FlashcardOcclusion[];
  revealed?: boolean;
  editable?: boolean;
  loading?: "eager" | "lazy";
  onChange?: (occlusions: FlashcardOcclusion[]) => void;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function boxFromPoints(start: Point, end: Point): FlashcardOcclusion {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.max(0, Math.max(start.x, end.x) - x),
    height: Math.max(0, Math.max(start.y, end.y) - y),
  };
}

export function ImageOcclusionCanvas({ imageUrl, occlusions, revealed = false, editable = false, loading = "eager", onChange }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<FlashcardOcclusion | null>(null);

  const pointFor = (clientX: number, clientY: number): Point | null => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    return {
      x: clamp((clientX - bounds.left) / bounds.width),
      y: clamp((clientY - bounds.top) / bounds.height),
    };
  };

  const finishDrawing = (clientX: number, clientY: number) => {
    if (!editable || !start) return;
    const end = pointFor(clientX, clientY);
    if (end) {
      const next = boxFromPoints(start, end);
      if (next.width >= 0.02 && next.height >= 0.02) onChange?.([...occlusions, next]);
    }
    setStart(null);
    setDraft(null);
  };

  const visibleOcclusions = draft ? [...occlusions, draft] : occlusions;

  return <div className={`flashcards-occlusion-editor ${editable ? "editable" : ""}`}>
    {editable && <small>在图片上拖动绘制遮挡区域；至少绘制一个。坐标会自动适配不同屏幕。</small>}
    <div
      ref={canvasRef}
      className={`flashcards-occlusion-canvas ${revealed ? "revealed" : "masked"}`}
      onPointerDown={(event) => {
        if (!editable || event.button !== 0) return;
        const point = pointFor(event.clientX, event.clientY);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setStart(point);
        setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (!editable || !start) return;
        const point = pointFor(event.clientX, event.clientY);
        if (point) setDraft(boxFromPoints(start, point));
      }}
      onPointerUp={(event) => finishDrawing(event.clientX, event.clientY)}
      onPointerCancel={() => { setStart(null); setDraft(null); }}
    >
      <img src={imageUrl} alt="图片遮挡卡" draggable={false} loading={loading} decoding="async" />
      {visibleOcclusions.map((item, index) => <span
        key={`${index}-${item.x}-${item.y}-${item.width}-${item.height}`}
        className="flashcards-occlusion-mask"
        style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.width * 100}%`, height: `${item.height * 100}%` }}
      >{index + 1}</span>)}
    </div>
    {editable && occlusions.length > 0 && <div className="flashcards-occlusion-list">
      {occlusions.map((item, index) => <span key={`${index}-${item.x}-${item.y}`}>
        遮挡 {index + 1}
        <button type="button" onClick={() => onChange?.(occlusions.filter((_, itemIndex) => itemIndex !== index))} title={`删除遮挡 ${index + 1}`}><Trash2 size={13} /></button>
      </span>)}
    </div>}
  </div>;
}
