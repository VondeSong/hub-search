export type SourceFilters = { craft: boolean; task: boolean; pdf: boolean; media: boolean; attachment: boolean; reading?: boolean; flashcard?: boolean };

export function normalizeSourceFilters(value: unknown): Required<SourceFilters> {
  const source=value&&typeof value==="object"?value as Record<string,unknown>:{};
  const legacy={craft:source.craft!==false,task:source.task!==false,pdf:source.pdf!==false,
    media:typeof source.media==="boolean"?source.media:source.image!==false,attachment:source.attachment!==false};
  const all=Object.values(legacy).every(Boolean);
  return {...legacy,reading:typeof source.reading==="boolean"?source.reading:all,
    flashcard:typeof source.flashcard==="boolean"?source.flashcard:all};
}
