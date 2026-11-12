import { contentOf, isContainer, libraries, libraryNodes, nodeById, pathOf, type LibraryNode } from "./library-data";
import type { AssistantContext } from "./Assistant";

export const libraryDragType = "application/x-hub-library-material";
const prefix = "library:";
export function assistantLibraryNode(id: string): LibraryNode | undefined {
  if (!id.startsWith(prefix)) return;
  const node = nodeById[id.slice(prefix.length)];
  if (node && !isContainer(node) && node.access !== "restricted" && contentOf(node).access !== "restricted") return node;
}
export function isLibraryReference(id: string) { return id.startsWith(prefix); }

const libraryMaterial = (node: LibraryNode): AssistantContext => {
  const content = contentOf(node);
  return { id: prefix + node.id, title: node.filename || node.title,
    excerpt: (content.sections?.map(section => section.text || section.items?.join("\n") || "").join("\n\n") || node.description || "").slice(0, 8000),
    kind: node.imageSrc ? "image" : node.kind, writable: false,
    libraryId: node.library === "dida" ? "ticktick" : node.library, libraryName: libraries[node.library].provider, path: pathOf(node) };
};

export const assistantLibraryCatalog = libraryNodes.filter(node => assistantLibraryNode(prefix + node.id)).map(libraryMaterial);

export function libraryDragProps(node: LibraryNode) {
  const id = prefix + node.id;
  if (!assistantLibraryNode(id)) return {};
  return { draggable: true, "data-assistant-drag": "", onDragStart: (event: {dataTransfer: DataTransfer}) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(libraryDragType, id);
  }};
}
