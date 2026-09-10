import { Canvas, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  TransformControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  Suspense,
} from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CameraSpec, Scene, SceneCommand } from "./types";
import { frameThumbnail, subjectBounds } from "./thumbnailFraming";
import { applySceneLight } from "./sceneLighting";
export type ViewportHandle = {
  camera: () => CameraSpec;
  view: (v: string) => void;
  fit: () => void;
  screenshot: () => string;
  sampleCamera: () => CameraSpec;
  restoreCamera: (c: CameraSpec) => void;
  drawVideo: (target: HTMLCanvasElement) => void;
};
export type ViewportProps = {
  url: string | null;
  scene: Scene;
  selected: string | null;
  onSelect: (id: string | null) => void;
  mode: "select" | "translate" | "rotate" | "scale";
  busy: boolean;
  onTransform: (id: string, t: SceneCommand["transform"]) => void;
  onError: (s: string) => void;
  readOnly?: boolean;
  thumbnail?: boolean;
  hideGizmo?: boolean;
  onCameraChange?: (camera: CameraSpec) => void;
  onReady?: () => void;
  frameAspect?: number;
  imageAspect?: number;
  transparentPreview?: boolean;
  showGrid?: boolean;
  controlsEnabled?: boolean;
};
const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2),
  Ci = C.clone().invert();
export function blenderTransform(m: THREE.Matrix4) {
  const local = Ci.clone().multiply(m).multiply(C);
  const p = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    s = new THREE.Vector3();
  local.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return {
    position: p.toArray(),
    rotation: [e.x, e.y, e.z] as [number, number, number],
    scale: s.toArray(),
  };
}
function Content({
  props,
  handle,
}: {
  props: ViewportProps;
  handle: React.ForwardedRef<ViewportHandle>;
}) {
  const { camera, gl, invalidate, size, scene } = useThree();
  useEffect(() => {
    gl.toneMapping = props.scene.lighting ? (props.scene.lighting.viewTransform === "AgX" ? THREE.AgXToneMapping : THREE.LinearToneMapping) : THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 2 ** (props.scene.lighting?.exposure || 0);
    invalidate();
  }, [props.scene.lighting, gl, invalidate]);
  useEffect(() => {
    const lighting = props.scene.lighting;
    if (!lighting) return;
    const color = new THREE.Color(lighting.worldColor);
    // PMREM needs at least a 16px cube face (64px equirectangular width).
    const pixels = new Float32Array(128 * 64 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([color.r, color.g, color.b, 1], i);
    const environment = new THREE.DataTexture(pixels, 128, 64, THREE.RGBAFormat, THREE.FloatType);
    environment.mapping = THREE.EquirectangularReflectionMapping; environment.needsUpdate = true;
    const generator = new THREE.PMREMGenerator(gl), target = generator.fromEquirectangular(environment);
    scene.environment = target.texture; scene.environmentIntensity = lighting.worldStrength;
    invalidate();
    return () => { scene.environment = null; scene.environmentIntensity = 1; target.dispose(); generator.dispose(); environment.dispose(); };
  }, [props.scene.lighting, gl, scene, invalidate]);
  const sampleCamera = (): CameraSpec => ({
    position: camera.position.toArray(),
    target: orbit.current?.target.toArray() || [0, 0, 0],
    up: camera.up.toArray(),
    fov: (camera as THREE.PerspectiveCamera).fov,
    aspect: (camera as THREE.PerspectiveCamera).aspect,
  });
  const orbit = useRef<any>(null);
  const transform = useRef<any>(null);
  const [group, setGroup] = useState<THREE.Group | null>(null);
  const [objects, setObjects] = useState(new Map<string, THREE.Object3D>());
  const bounds = useRef(new THREE.Box3());
  const thumbnailCorners = useRef<THREE.Vector3[]>([]);
  const dragging = useRef(false);
  const clickStart = useRef<[number, number]>([0, 0]);
  const fit = () => {
    const b = bounds.current;
    if (b.isEmpty()) return;
    if (props.thumbnail) {
      const target = frameThumbnail(b, camera as THREE.PerspectiveCamera, thumbnailCorners.current);
      if (target) orbit.current?.target.copy(target);
      orbit.current?.update();
      invalidate();
      return;
    }
    const center = b.getCenter(new THREE.Vector3()),
      size = b.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.y, size.z, 1) * 1.3;
    camera.position.copy(center).add(new THREE.Vector3(d, d * 0.7, d));
    camera.up.set(0, 1, 0);
    orbit.current?.target.copy(center);
    orbit.current?.update();
    invalidate();
  };
  useImperativeHandle(
    handle,
    () => ({
      camera: () => {
        // Finish the tiny orbit damping remainder before freezing a render camera.
        const controls = orbit.current;
        if (controls) {
          const damping = controls.enableDamping;
          controls.enableDamping = false;
          controls.update();
          controls.enableDamping = damping;
        }
        return {
          position: camera.position.toArray(),
          target: orbit.current.target.toArray(),
          up: camera.up.toArray(),
          fov: (camera as THREE.PerspectiveCamera).fov,
          aspect: (camera as THREE.PerspectiveCamera).aspect,
        };
      },
      sampleCamera,
      restoreCamera: (c) => {
        const controls = orbit.current;
        if (controls) {
          controls.enableDamping = false;
          controls.update();
        }
        camera.position.fromArray(c.position);
        camera.up.fromArray(c.up);
        controls?.target.fromArray(c.target);
        camera.lookAt(...c.target);
        if (controls) {
          controls.update();
          controls.enableDamping = true;
        }
        invalidate();
      },
      drawVideo: (target) => {
        gl.render(scene, camera);
        const source = gl.domElement,
          aspect = target.width / target.height,
          sw = Math.min(source.width, source.height * aspect),
          sh = sw / aspect;
        target
          .getContext("2d")!
          .drawImage(
            source,
            (source.width - sw) / 2,
            (source.height - sh) / 2,
            sw,
            sh,
            0,
            0,
            target.width,
            target.height,
          );
      },
      screenshot: () => {
        gl.render(scene, camera);
        return gl.domElement.toDataURL("image/png");
      },
      fit,
      view: (v) => {
        if (v === "perspective") {
          fit();
          return;
        }
        const center = bounds.current.isEmpty()
          ? new THREE.Vector3()
          : bounds.current.getCenter(new THREE.Vector3());
        const d = Math.max(camera.position.distanceTo(orbit.current.target), 3);
        const axes: Record<string, number[]> = {
          front: [0, 0, 1],
          side: [1, 0, 0],
          top: [0, 1, 0.0001],
        };
        const a = axes[v] || axes.front;
        camera.position
          .copy(center)
          .add(new THREE.Vector3(...a).multiplyScalar(d));
        camera.up.set(0, 1, 0);
        orbit.current.target.copy(center);
        orbit.current.update();
        invalidate();
      },
    }),
    [group],
  );
  useEffect(() => {
    if (!props.url) {
      setGroup(null);
      setObjects(new Map());
      return;
    }
    setGroup(null);
    setObjects(new Map());
    let alive = true;
    let loaded: THREE.Group | undefined;
    const dispose = (g: THREE.Group) =>
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material)
            ? o.material
            : [o.material]) {
            Object.values(m).forEach((v) => {
              if (v instanceof THREE.Texture) v.dispose();
            });
            m.dispose();
          }
        }
      });
    new GLTFLoader().load(
      props.url,
      (gltf) => {
        loaded = gltf.scene;
        if (!alive) {
          dispose(loaded);
          return;
        }
        const map = new Map<string, THREE.Object3D>();
        loaded.traverse((o) => {
          if (o.userData.forma_id) map.set(o.userData.forma_id, o);
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        props.scene.objects.forEach((o) => {
          const node = map.get(o.id);
          if (node) {
            node.visible = o.visible;
            if (o.type === "LIGHT" && o.light) {
              applySceneLight(node, o.light);
            }
          }
        });
        bounds.current.makeEmpty();
        loaded.updateMatrixWorld(true);
        loaded.traverse((o) => {
          if (
            o instanceof THREE.Mesh &&
            o.visible &&
            !/地面|floor|ground|背景/i.test(o.name)
          ) {
            o.geometry.computeBoundingBox();
            if (o.geometry.boundingBox)
              bounds.current.union(
                o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld),
              );
          }
        });
        if (props.thumbnail) {
          bounds.current.copy(subjectBounds(loaded, thumbnailCorners.current));
          fitted.current = false;
        }
        setGroup(loaded);
        setObjects(map);
      },
      undefined,
      (e) => {
        if (alive) props.onError("真实 GLB 加载失败：" + String(e));
      },
    );
    return () => {
      alive = false;
      if (loaded) dispose(loaded);
    };
  }, [props.url]);
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    // Keep the centered crop frame at a constant 42 degree vertical field of view.
    const visibleFraction = !props.imageAspect && props.frameAspect
      ? Math.min(1, size.width / size.height / props.frameAspect)
      : 1;
    cam.fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(Math.tan(THREE.MathUtils.degToRad(42 / 2)) / visibleFraction),
    );
    cam.aspect = props.imageAspect || size.width / size.height;
    cam.updateProjectionMatrix();
    invalidate();
  }, [props.frameAspect, props.imageAspect, size.width, size.height]);
  const fitted = useRef(false);
  useEffect(() => {
    if (group && !fitted.current) {
      fit();
      fitted.current = true;
    }
  }, [group]);
  const readyCallback = useRef(props.onReady);
  readyCallback.current = props.onReady;
  useEffect(() => {
    if (!group) return;
    // Wait for the React scene commit and fitted camera, not just GLB decoding.
    let nextFrame = 0;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => readyCallback.current?.());
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
    };
  }, [group]);
  const selected =
    !props.readOnly && props.selected ? objects.get(props.selected) : undefined;
  const pivot = useMemo(() => new THREE.Object3D(), []);
  const pivotStart = useRef(new THREE.Matrix4());
  const objectStart = useRef(new THREE.Matrix4());
  useEffect(() => {
    if (!selected) return;
    selected.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(selected);
    if (box.isEmpty()) selected.getWorldPosition(pivot.position);
    else box.getCenter(pivot.position);
    selected.getWorldQuaternion(pivot.quaternion);
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
  }, [selected, group, props.busy, pivot]);

  useEffect(() => {
    if (!selected) return;
    const helper = new THREE.BoxHelper(selected, 0x1977ff);
    helper.renderOrder = 1000;
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    gl.domElement.style.cursor = "default";
    const parent = group?.parent;
    parent?.add(helper);
    let raf = 0;
    const frame = () => {
      helper.update();
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      parent?.remove(helper);
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    };
  }, [selected, group]);
  return (
    <>
      {!props.transparentPreview && <color attach="background" args={["#f8f8f6"]} />}
      {!props.scene.lighting && <>
        <ambientLight intensity={1.2} />
        <directionalLight position={[4, 7, 5]} intensity={2.5} />
        <directionalLight position={[-4, 3, -3]} intensity={1} />
      </>}
      {props.showGrid !== false && !props.transparentPreview && (
        <Grid
          infiniteGrid
          position={[0, -0.006, 0]}
          cellSize={0.25}
          sectionSize={1}
          cellColor="#d9dfdc"
          sectionColor="#aebbb5"
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={20}
          fadeStrength={1.5}
        />
      )}
      {group && (
        <primitive
          object={group}
          onPointerDown={(e: any) => {
            clickStart.current = [e.clientX, e.clientY];
          }}
          onClick={(e: any) => {
            if (
              props.readOnly ||
              dragging.current ||
              Math.hypot(
                e.clientX - clickStart.current[0],
                e.clientY - clickStart.current[1],
              ) > 4
            )
              return;
            e.stopPropagation();
            let n = e.object;
            while (n && !n.userData.forma_id) n = n.parent;
            props.onSelect(n?.userData.forma_id || null);
          }}
        />
      )}
      <OrbitControls
        ref={orbit}
        enabled={props.controlsEnabled ?? true}
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={props.thumbnail ? 0 : 0.2}
        maxDistance={props.thumbnail ? Infinity : 150}
        onChange={() => {
          if (orbit.current)
            props.onCameraChange?.({
              position: camera.position.toArray(),
              target: orbit.current.target.toArray(),
              up: camera.up.toArray(),
              fov: (camera as THREE.PerspectiveCamera).fov,
              aspect: (camera as THREE.PerspectiveCamera).aspect,
            });
        }}
      />
      <primitive object={pivot} />
      {selected && props.mode !== "select" && !props.busy && (
        <TransformControls
          ref={transform}
          object={pivot}
          mode={props.mode}
          space="local"
          size={0.85}
          onMouseDown={() => {
            dragging.current = true;
            selected.updateWorldMatrix(true, true);
            pivot.updateMatrixWorld(true);
            pivotStart.current.copy(pivot.matrixWorld);
            objectStart.current.copy(selected.matrixWorld);
          }}
          onObjectChange={() => {
            if (!dragging.current) return;
            pivot.updateMatrixWorld(true);
            const local = pivot.matrixWorld
              .clone()
              .multiply(pivotStart.current.clone().invert())
              .multiply(objectStart.current);
            if (selected.parent)
              local.premultiply(selected.parent.matrixWorld.clone().invert());
            local.decompose(
              selected.position,
              selected.quaternion,
              selected.scale,
            );
            selected.updateMatrixWorld(true);
          }}
          onMouseUp={() => {
            selected.updateMatrix();
            props.onTransform(
              props.selected!,
              blenderTransform(selected.matrix),
            );
            setTimeout(() => {
              dragging.current = false;
            }, 100);
          }}
        />
      )}
      {!props.hideGizmo && (
        <GizmoHelper
          alignment="top-right"
          margin={[58, Math.min(160, size.height * 0.15)]}
        >
          <GizmoViewport
            axisColors={["#dc655e", "#6ba684", "#6398eb"]}
            labelColor="#fff"
          />
        </GizmoHelper>
      )}
    </>
  );
}
export const Viewport = forwardRef<ViewportHandle, ViewportProps>(
  (props, ref) => (
    <Canvas
      shadows
      camera={{ position: [5, 3.5, 5], fov: 42, near: 0.01, far: 1000 }}
      dpr={props.thumbnail ? 1 : [1, 2]}
      onPointerMissed={(e) => {
        if (e.type === "click") props.onSelect(null);
      }}
      gl={{
        antialias: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true,
      }}
    >
      <Suspense fallback={null}>
        <Content props={props} handle={ref} />
      </Suspense>
    </Canvas>
  ),
);
