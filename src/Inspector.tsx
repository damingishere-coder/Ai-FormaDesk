import { useEffect, useState } from "react";
import { X, Copy, Trash2, Eye, EyeOff, Box, Lightbulb } from "lucide-react";
import type { SceneObject, SceneCommand } from "./types";
export function Inspector({
  object,
  busy,
  onClose,
  onCommand,
}: {
  object: SceneObject;
  busy: boolean;
  onClose: () => void;
  onCommand: (c: Partial<SceneCommand>) => void;
}) {
  const [tab, setTab] = useState("transform");
  const [t, setT] = useState(object.transform);
  const [m, setM] = useState(
    object.material || { color: "#8f9d7a", roughness: 0.45, metalness: 0.1 },
  );
  const [l, setL] = useState(object.light || { color: "#ffffff", energy: 100 });
  useEffect(() => {
    setT(structuredClone(object.transform));
    setM(
      object.material || { color: "#8f9d7a", roughness: 0.45, metalness: 0.1 },
    );
    setL(object.light || { color: "#ffffff", energy: 100 });
  }, [object]);
  const mesh = ["MESH", "CURVE", "FONT", "SURFACE", "META"].includes(
    object.type,
  );
  return (
    <aside className="inspector glass" aria-label="对象属性">
      <header>
        {object.type === "LIGHT" ? <Lightbulb size={19} /> : <Box size={19} />}
        <strong title={object.id}>{object.name}</strong>
        <button className="icon" aria-label="关闭属性面板" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      {object.subjectId && (
        <p className="muted">照片主体的初始尺度为估算，可按实测尺寸调整。</p>
      )}
      <div className="tabs">
        <button
          className={tab === "transform" ? "active" : ""}
          onClick={() => setTab("transform")}
        >
          变换
        </button>
        {mesh && (
          <button
            className={tab === "material" ? "active" : ""}
            onClick={() => setTab("material")}
          >
            外观
          </button>
        )}
        {object.light && (
          <button
            className={tab === "light" ? "active" : ""}
            onClick={() => setTab("light")}
          >
            灯光
          </button>
        )}
      </div>
      <fieldset disabled={busy}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCommand({
              operation:
                tab === "material" && mesh
                  ? "material"
                  : tab === "light" && object.light
                    ? "light"
                    : "transform",
              transform: t,
              material: m,
              light: l,
            });
          }}
        >
          {(tab === "transform" ||
            (tab === "material" && !mesh) ||
            (tab === "light" && !object.light)) && (
            <div className="transform-fields">
              {(["position", "rotation", "scale"] as const).map((key, i) => (
                <div key={key}>
                  <label>
                    {["位置", "旋转", "缩放"][i]}
                    <small>{["m", "°", "倍"][i]}</small>
                  </label>
                  <div className="xyz">
                    {["X", "Y", "Z"].map((axis, j) => (
                      <label key={axis}>
                        <span className={"axis-" + axis}>{axis}</span>
                        <input
                          aria-label={`${["位置", "旋转", "缩放"][i]} ${axis}`}
                          type="number"
                          step={key === "rotation" ? 1 : 0.05}
                          value={Number(
                            (
                              t[key][j] *
                              (key === "rotation" ? 180 / Math.PI : 1)
                            ).toFixed(4),
                          )}
                          onChange={(e) => {
                            const n =
                              Number(e.target.value) /
                              (key === "rotation" ? 180 / Math.PI : 1);
                            setT({
                              ...t,
                              [key]: t[key].map((v, k) => (k === j ? n : v)),
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <p className="field-note">
                沿对象局部坐标编辑，确认后保存到 Blender。
              </p>
            </div>
          )}
          {tab === "material" && mesh && (
            <div className="appearance">
              <p className="field-note">
                有贴图时，基础颜色作为颜色系数保留原花纹。
              </p>
              <button
                type="button"
                onClick={() =>
                  onCommand({
                    operation: "material",
                    material: m,
                    replaceTexture: true,
                  })
                }
              >
                替换为纯色
              </button>
              <label>
                基础颜色
                <input
                  aria-label="基础颜色"
                  type="color"
                  value={m.color}
                  onChange={(e) => setM({ ...m, color: e.target.value })}
                />
              </label>
              <div className="swatches">
                {["#81916e", "#e2ded3", "#363936", "#c66c43", "#2c455e"].map(
                  (c) => (
                    <button
                      type="button"
                      key={c}
                      aria-label={"颜色 " + c}
                      className={m.color === c ? "chosen" : ""}
                      style={{ background: c }}
                      onClick={() => setM({ ...m, color: c })}
                    />
                  ),
                )}
              </div>
              {(["roughness", "metalness"] as const).map((key, i) => (
                <label className="slider-row" key={key}>
                  {["粗糙度", "金属感"][i]}
                  <input
                    aria-label={["粗糙度", "金属感"][i]}
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value={m[key]}
                    onChange={(e) =>
                      setM({ ...m, [key]: Number(e.target.value) })
                    }
                  />
                  <span>{m[key].toFixed(2)}</span>
                </label>
              ))}
              <p className="field-note">只修改当前对象，自动隔离共享材质。</p>
            </div>
          )}
          {tab === "light" && object.light && (
            <div className="appearance">
              <label>
                灯光颜色
                <input
                  aria-label="灯光颜色"
                  type="color"
                  value={l.color}
                  onChange={(e) => setL({ ...l, color: e.target.value })}
                />
              </label>
              <label>
                强度
                <input
                  aria-label="灯光强度"
                  className="energy"
                  type="number"
                  min="0"
                  max="1000000"
                  value={l.energy}
                  onChange={(e) =>
                    setL({ ...l, energy: Number(e.target.value) })
                  }
                />
              </label>
              <p className="field-note">
                {object.light.type === "SUN" ? "太阳光" : "点光源"} ·
                方向在变换页设置
              </p>
            </div>
          )}
          <button className="save-property" type="submit">
            {busy ? "正在保存…" : "应用并保存"}
          </button>
        </form>
      </fieldset>
      <footer>
        <span className="object-id" title={object.id}>
          ID {object.id.slice(0, 6)}
        </span>
        <button
          className="icon"
          disabled={busy}
          aria-label={object.visible ? "隐藏对象" : "显示对象"}
          onClick={() =>
            onCommand({ operation: "visibility", visible: !object.visible })
          }
        >
          {object.visible ? <Eye size={17} /> : <EyeOff size={17} />}
        </button>
        <button
          className="icon"
          disabled={busy}
          aria-label="复制对象"
          onClick={() => onCommand({ operation: "duplicate" })}
        >
          <Copy size={17} />
        </button>
        <button
          className="icon danger"
          disabled={busy}
          aria-label="删除对象"
          onClick={() => onCommand({ operation: "delete" })}
        >
          <Trash2 size={17} />
        </button>
      </footer>
    </aside>
  );
}
