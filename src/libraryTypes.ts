import type { Project } from "./types";
export type LibraryView = "grid" | "list";
export type LibrarySort = "updated" | "created" | "name";
export type ProjectFileKind = "model" | "animation" | "image" | "video";
export type ProjectFile = {
  id: string;
  projectId: string;
  revisionId: string | null;
  kind: ProjectFileKind;
  name: string;
  format: string;
  createdAt: string;
  url: string;
  available: boolean;
  size: number;
  current: boolean;
};
export const fileKindNames: Record<ProjectFileKind, string> = {
  model: "模型",
  animation: "动画工程",
  image: "图片",
  video: "视频",
};
export function filterLibrary(
  projects: Project[],
  query: string,
  favorite: boolean,
  sort: LibrarySort,
) {
  const term = query.trim().toLocaleLowerCase();
  return projects
    .filter(
      (p) =>
        (!favorite || p.favorite) && p.name.toLocaleLowerCase().includes(term),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
        : (sort === "created"
            ? b.createdAt
            : b.updatedAt || b.createdAt
          ).localeCompare(
            sort === "created" ? a.createdAt : a.updatedAt || a.createdAt,
          ),
    );
}
