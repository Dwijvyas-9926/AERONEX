import { ContactShadows, OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { ACESFilmicToneMapping, DoubleSide, type BufferGeometry } from "three";
import { GRAPHICS, useSettings } from "../../../state/settingsStore";
import { assemble } from "../assembly";
import { type FrameDesign } from "../geometry";
import { FALLBACK_FINISH, lookForPart, MATERIAL_FINISH, STUDIO } from "../parts";
import { geometryFor } from "../solid";

/*
  Solid view.

  The meshes here are the very same extrusions the STL exporter writes, so what
  the user turns around on screen is what their printer or cutter receives — a
  preview built from a prettier, separate model would be free to disagree with
  the files, which is the one thing a design preview must never do.

  Units are millimetres throughout; the scene is scaled down once at the root
  so the camera can work in sensible numbers.
*/

interface Props {
  design: FrameDesign;
  exploded: boolean;
}

interface Finish {
  color: string;
  metalness: number;
  roughness: number;
}

function Part({
  geometry,
  look,
  z,
  rotation = 0,
  shift = 0,
}: {
  geometry: BufferGeometry;
  look: Finish;
  z: number;
  rotation?: number;
  shift?: number;
}) {
  return (
    // Profiles are drawn in XY and extruded along +Z, which is exactly how the
    // aircraft sits: lay the scene on its back by rotating -90° about X.
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <group rotation={[0, 0, rotation]}>
        <mesh geometry={geometry} position={[shift, 0, z]} castShadow receiveShadow>
          <meshStandardMaterial
            color={look.color}
            metalness={look.metalness}
            roughness={look.roughness}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

/**
 * A camera side plate, stood on edge.
 *
 * Every other part lies flat, so its profile plane is the plan and no extra
 * rotation is needed. These two stand vertically facing each other across the
 * camera, which asks for a cyclic permutation of the profile's own axes: its
 * length becomes the frame's fore-aft, its height becomes up, and its
 * thickness becomes the across-frame direction.
 *
 * In three's default XYZ Euler order that permutation is [90°, 90°, 0], not
 * the [90°, 0, 90°] it first looked like — the latter sends the plate's
 * length straight up, which stood the plates on their noses in the middle of
 * the frame instead of on their feet at the front of it.
 */
function CameraPart({
  geometry,
  look,
  x,
  y,
  z,
}: {
  geometry: BufferGeometry;
  look: Finish;
  x: number;
  y: number;
  z: number;
}) {
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group position={[x, y, z]} rotation={[Math.PI / 2, Math.PI / 2, 0]}>
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={look.color}
            metalness={look.metalness}
            roughness={look.roughness}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

/**
 * Explicit three-point lighting, no image-based environment.
 *
 * A generated room environment was tried here and rejected: it is a bright
 * white-walled space whose ambient contribution swamped the base colours, so
 * carbon, nylon and plywood all rendered as the same pale grey no matter what
 * they were set to. Plain lights at known intensities keep each material
 * looking like itself, and cost less to render besides.
 */
function ToneMap() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = 1;
  }, [gl]);
  return null;
}

/**
 * Stand the camera far enough back that the whole aircraft is in frame.
 *
 * The field of view is fixed vertically, so on a canvas taller than it is
 * wide — which the preview column is, on every screen narrower than a
 * desktop monitor — a distance worked out from the vertical angle alone
 * leaves the arms hanging out of both sides. The distance is taken from
 * whichever of the two angles is the tighter, and re-taken when the canvas
 * changes shape or the frame changes size.
 */
function FitCamera({ reach, height }: { reach: number; height: number }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as { update?: () => void } | null;
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const vHalf = (38 / 2) * (Math.PI / 180);
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const radius = Math.hypot(reach, height) * 1.08;
    const dist = radius / Math.sin(Math.min(vHalf, hHalf));
    // Keep whatever direction the user has turned the model to.
    const dir = camera.position.clone().normalize();
    camera.position.copy(dir.multiplyScalar(dist));
    camera.near = Math.max(1, dist / 100);
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls?.update?.();
  }, [camera, controls, size.width, size.height, reach, height]);
  return null;
}

export function Frame3D({ design: d, exploded }: Props) {
  const graphics = useSettings((s) => s.graphics);
  const preset = GRAPHICS[graphics];

  /*
    Where each part sits comes from assemble(), the same placement the build
    report's pictures use, so the screen and the report cannot disagree. The
    scene is built from whatever parts the design actually has: a unibody has
    a "chassis" and no separate arms, a dead cat has two arm parts.
  */
  const asm = useMemo(() => assemble(d, exploded), [d, exploded]);

  /*
    One geometry per distinct part, shared by every placement of it (four
    arms, two camera plates). Extruded geometries hold GPU buffers and a new
    set is built on every change to the design, so they are disposed when
    replaced; without that the page leaks a few hundred kilobytes per edit.
  */
  const geometries = useMemo(() => new Map(d.profiles.map((p) => [p.id, geometryFor(p)])), [d.profiles]);
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);

  const finish = MATERIAL_FINISH[d.material.id] ?? FALLBACK_FINISH;
  const lookFor = (id: string): Finish => ({ ...finish, color: lookForPart(id).color });
  const { reach } = asm;

  return (
    <Canvas
      className="fs-canvas"
      dpr={preset.dpr}
      shadows={preset.shadows}
      /*
        Frame the whole aircraft. At 38° the half-angle is 19°, so the camera
        has to stand off by about reach/tan(19°) — roughly 2.9 × reach — or the
        arm tips sit outside the frustum and the model looks cropped.
      */
      camera={{ position: [reach * 1.4, reach * 1.25, reach * 1.6], fov: 38, near: 1, far: reach * 20 }}
    >
      {/*
        A light studio ground. On a dark field a carbon or nylon frame — both
        of which are nearly black — showed as a silhouette with no readable
        edges or holes.
      */}
      <color attach="background" args={[STUDIO.background]} />
      {/* Key from the front-right, a cool fill from behind-left to keep the
          shaded sides from going flat, and ambient lifted for the light room. */}
      <ambientLight intensity={STUDIO.ambient} color={STUDIO.ambientColor} />
      <directionalLight position={[reach, reach * 1.5, reach * 0.8]} intensity={STUDIO.key} color={STUDIO.keyColor} castShadow={preset.shadows} />
      <directionalLight position={[-reach * 0.8, reach * 0.5, -reach]} intensity={STUDIO.fill} color={STUDIO.fillColor} />
      <ToneMap />
      <FitCamera reach={reach} height={asm.topZ + (d.cameraMount?.heightMm ?? 0)} />
      <ContactShadows position={[0, -1, 0]} scale={reach * 3} blur={2.6} opacity={0.3} far={reach} />

      <group>
        {asm.flat.map((p, i) => (
          <Part key={`f-${i}`} geometry={geometries.get(p.profile.id)!} look={lookFor(p.profile.id)} z={p.z} rotation={p.rotation} shift={p.shift} />
        ))}
        {asm.standoffs.map((st, i) => (
          <group key={`st-${i}`} rotation={[-Math.PI / 2, 0, 0]}>
            {/* A cylinder's axis is its own Y; stand it along the scene's up. */}
            <mesh position={[st.x, st.y, st.z0 + st.h / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[st.r, st.r, st.h, 6]} />
              <meshStandardMaterial color={STUDIO.standoff} metalness={0.85} roughness={0.35} />
            </mesh>
          </group>
        ))}
        {asm.standing.map((p, i) => (
          <CameraPart key={`c-${i}`} geometry={geometries.get(p.profile.id)!} look={lookFor(p.profile.id)} x={p.x} y={p.y} z={p.z} />
        ))}
      </group>

      <OrbitControls
        enablePan={false}
        minDistance={reach * 0.6}
        maxDistance={reach * 12}
        makeDefault
        autoRotate={!exploded}
        autoRotateSpeed={0.5}
        target={[0, asm.topZ * 0.4, 0]}
      />
    </Canvas>
  );
}
