import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { SceneObject } from "./types";
RectAreaLightUniformsLib.init();

/** Radiometric units shared with Blender's glTF COMPAT conversion. */
export function applySceneLight(
  node: THREE.Object3D,
  value: NonNullable<SceneObject["light"]>,
) {
  if (value.type === "AREA") {
    const width = value.size || 1,
      height = value.sizeY || width;
    const light = new THREE.RectAreaLight(
      value.color,
      value.energy / (Math.PI * width * height),
      width,
      height,
    );
    light.name = "FormaAreaLight";
    node.add(light);
  } else {
    node.traverse((child) => {
      if (child instanceof THREE.Light) {
        child.intensity =
          value.type === "SUN" ? value.energy : value.energy / (4 * Math.PI);
        child.color.set(value.color);
        child.castShadow = true;
      }
    });
  }
}
