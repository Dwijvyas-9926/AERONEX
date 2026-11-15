import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  WebGLRenderer,
  Vector3,
  type BufferGeometry,
} from "three";
import { assemble } from "./assembly";
import { type FrameDesign } from "./geometry";
import { FALLBACK_FINISH, lookForPart, MATERIAL_FINISH, STUDIO } from "./parts";
import { type JpegImage } from "./pdf";
import { geometryFor } from "./solid";

/*
  A still picture of the frame for the build report.

  Rendered off screen with the solid view's own placement (assemble), meshes
  (geometryFor), part colours, material finishes and lights, so the picture
  is the model the user has been turning round, not a separate drawing of it.
  Where the browser has no WebGL the report goes without pictures; it never
  fails because of them.
*/

export interface RenderOptions {
  exploded?: boolean;
  widthPx?: number;
  heightPx?: number;
  /** Direction the camera looks from, before scaling. */
  from?: [number, number, number];
}

export async function renderFrame(d: FrameDesign, opts: RenderOptions = {}): Promise<JpegImage | null> {
  const { exploded = false, widthPx = 1600, heightPx = 1000, from = [1.4, 1.1, 1.6] } = opts;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  const disposables: { dispose: () => void }[] = [];
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(widthPx, heightPx, false);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    const asm = assemble(d, exploded);
    const { reach } = asm;
    const scene = new Scene();
    scene.background = new Color(STUDIO.background);
    scene.add(new AmbientLight(STUDIO.ambientColor, STUDIO.ambient));
    const key = new DirectionalLight(STUDIO.keyColor, STUDIO.key);
    key.position.set(reach, reach * 1.5, reach * 0.8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -reach * 1.6;
    sc.right = sc.top = reach * 1.6;
    sc.near = 1;
    sc.far = reach * 6;
    key.shadow.bias = -0.0005;
    scene.add(key);
    const fill = new DirectionalLight(STUDIO.fillColor, STUDIO.fill);
    fill.position.set(-reach * 0.8, reach * 0.5, -reach);
    scene.add(fill);

    // A soft shadow on the studio floor, like the contact shadow on screen.
    const floorGeo = new PlaneGeometry(reach * 8, reach * 8);
    const floorMat = new ShadowMaterial({ opacity: 0.16 });
    disposables.push(floorGeo, floorMat);
    const floor = new Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1;
    floor.receiveShadow = true;
    scene.add(floor);

    const finish = MATERIAL_FINISH[d.material.id] ?? FALLBACK_FINISH;
    const geos = new Map<string, BufferGeometry>();
    const geo = (id: string) => {
      let g = geos.get(id);
      if (!g) {
        g = geometryFor(d.profiles.find((p) => p.id === id)!);
        geos.set(id, g);
        disposables.push(g);
      }
      return g;
    };
    const mats = new Map<string, MeshStandardMaterial>();
    const mat = (id: string) => {
      let m = mats.get(id);
      if (!m) {
        m = new MeshStandardMaterial({ color: lookForPart(id).color, metalness: finish.metalness, roughness: finish.roughness, side: DoubleSide });
        mats.set(id, m);
        disposables.push(m);
      }
      return m;
    };

    // Profiles are drawn in XY and extruded along +Z: lay the aircraft on its back.
    const root = new Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    for (const p of asm.flat) {
      const turn = new Group();
      turn.rotation.z = p.rotation;
      const mesh = new Mesh(geo(p.profile.id), mat(p.profile.id));
      mesh.position.set(p.shift, 0, p.z);
      mesh.castShadow = mesh.receiveShadow = true;
      turn.add(mesh);
      root.add(turn);
    }
    for (const p of asm.standing) {
      const g = new Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.set(Math.PI / 2, Math.PI / 2, 0);
      const mesh = new Mesh(geo(p.profile.id), mat(p.profile.id));
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      root.add(g);
    }
    const standoffMat = new MeshStandardMaterial({ color: STUDIO.standoff, metalness: 0.85, roughness: 0.35 });
    disposables.push(standoffMat);
    for (const st of asm.standoffs) {
      const cyl = new CylinderGeometry(st.r, st.r, st.h, 6);
      disposables.push(cyl);
      const mesh = new Mesh(cyl, standoffMat);
      mesh.position.set(st.x, st.y, st.z0 + st.h / 2);
      mesh.rotation.x = Math.PI / 2;
      mesh.castShadow = true;
      root.add(mesh);
    }

    /*
      Frame the aircraft, not the sphere round it. A frame is wide and flat,
      so fitting its bounding sphere left it a small shape in a big empty
      picture. Instead points round its outline are projected and the camera is
      walked in or out until the widest of them sits just inside the edge.
      Three passes settle it; perspective makes each one nearly exact.
    */
    const fov = 30;
    const camera = new PerspectiveCamera(fov, widthPx / heightPx, 1, reach * 40);
    const target = new Vector3(0, asm.height * 0.35, 0);
    const dir = new Vector3(...from).normalize();
    const corners: Vector3[] = [];
    // Everything lies within `reach` of the centre in plan: ring it, top and bottom.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const y of [0, asm.height]) corners.push(new Vector3(Math.cos(a) * reach, y, Math.sin(a) * reach));
    }
    let dist = reach * 4;
    for (let pass = 0; pass < 3; pass++) {
      camera.position.copy(dir).multiplyScalar(dist).add(target);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      let ext = 0;
      for (const c of corners) {
        const v = c.clone().project(camera);
        ext = Math.max(ext, Math.abs(v.x), Math.abs(v.y));
      }
      dist *= ext / 0.9;
    }
    camera.position.copy(dir).multiplyScalar(dist).add(target);
    camera.lookAt(target);
    camera.near = Math.max(1, dist - reach * 3);
    camera.far = dist + reach * 6;
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), widthPx, heightPx };
  } catch {
    return null;
  } finally {
    for (const x of disposables) x.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
