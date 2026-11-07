export const formatDataSize = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
};

// Only presentation is simplified; storage and migration keep native paths.
export const formatDataPath = (path: string) => {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
};

export const isInDataDirectory = (path: string, root: string) => {
  const comparable = (value: string) => {
    const normal = formatDataPath(value).replace(/\\/g, "/").replace(/\/+$/, "");
    if (normal.split("/").includes("..")) return null;
    return /^(?:[a-z]:(?:\/|$)|\/\/)/i.test(normal) ? normal.toLowerCase() : normal;
  };
  const value = comparable(path), directory = comparable(root);
  return Boolean(value && directory && (value === directory || value.startsWith(`${directory}/`)));
};
