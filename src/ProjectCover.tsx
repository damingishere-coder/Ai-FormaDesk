import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Viewport, type ViewportHandle } from "./Viewport";
import type { Project, Snapshot } from "./types";

// Only one of these is mounted by the library, so old collections do not create
// a WebGL context per card. Saved JPEGs are used on subsequent visits.
export function ProjectCover({
  project,
  onSaved,
  onError,
}: {
  project: Project;
  onSaved: (url: string) => void;
  onError: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const viewport = useRef<ViewportHandle>(null);
  const requestStamp = useRef(Date.now());
  const callbacks = useRef({ onSaved, onError });
  callbacks.current = { onSaved, onError };
  const alive = useRef(false),
    saving = useRef(false),
    finished = useRef(false);
  function fail(message: string) {
    if (!alive.current || finished.current) return;
    finished.current = true;
    callbacks.current.onError(message);
  }
  useEffect(() => {
    alive.current = true;
    saving.current = false;
    finished.current = false;
    const timer = window.setTimeout(() => fail("封面生成超时"), 45_000);
    let cancelled = false;
    void api<Snapshot>(`/projects/${project.id}/scene`)
      .then((s) => {
        if (cancelled) return;
        if (!s.previewUrl || s.revision?.id !== project.currentRevisionId)
          throw new Error("作品版本已变化，请重新打开作品库");
        setSnapshot(s);
      })
      .catch((e) => {
        if (!cancelled) fail(e.message);
      });
    return () => {
      cancelled = true;
      alive.current = false;
      window.clearTimeout(timer);
    };
  }, [project.id, project.currentRevisionId]);
  async function capture() {
    if (saving.current || finished.current || !alive.current) return;
    saving.current = true;
    try {
      const image = viewport.current?.screenshot();
      if (!image || image === "data:,") throw new Error("无法读取作品封面");
      const result = await api<{ coverUrl: string }>(
        `/projects/${project.id}/cover`,
        {
          revisionId: project.currentRevisionId,
          image,
          replace: true,
        },
      );
      if (alive.current && !finished.current) {
        finished.current = true;
        callbacks.current.onSaved(result.coverUrl);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  }
  return (
    snapshot && (
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 640,
          height: 400,
          pointerEvents: "none",
        }}
      >
        <Viewport
          ref={viewport}
          url={
            snapshot.previewUrl +
            (snapshot.previewUrl?.includes("?") ? "&" : "?") +
            "cover=" +
            requestStamp.current
          }
          scene={snapshot.scene}
          selected={null}
          onSelect={() => {}}
          mode="select"
          busy={false}
          readOnly
          thumbnail
          hideGizmo
          controlsEnabled={false}
          onTransform={() => {}}
          onError={fail}
          onReady={() => void capture()}
        />
      </div>
    )
  );
}
