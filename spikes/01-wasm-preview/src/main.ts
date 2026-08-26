// THROWAWAY spike main thread (Issue #3).
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const viewport = document.getElementById("viewport")!;
const statsEl = document.getElementById("stats")!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight || 400);
renderer.setClearColor(0x111111);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
camera.position.set(80, -140, 100);
camera.up.set(0, 0, 1);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(100, -100, 200);
scene.add(dirLight);
scene.add(new THREE.AxesHelper(30));

const controls = new OrbitControls(camera, renderer.domElement);

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight || 400;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Stats state -----------------------------------------------------
type Stats = {
  status: string;
  coldInitMs?: number;
  bosl2SourceBytes?: number;
  bosl2FileCount?: number;
  manifoldProbe?: { ok: boolean; ms: number; stderr: string };
  renders: { index: number; ok: boolean; ms: number; wasmHeapBytes: number }[];
  done: boolean;
  allOk?: boolean;
};

const stats: Stats = { status: "booting", renders: [], done: false };

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function render() {
  const rows = stats.renders
    .map(
      (r) =>
        `<tr><td>${r.index}</td><td>${r.ok ? "ok" : "FAIL"}</td><td>${r.ms.toFixed(2)} ms</td><td>${fmtBytes(r.wasmHeapBytes)}</td></tr>`,
    )
    .join("");
  statsEl.innerHTML = `
    <div>status: <b>${stats.status}</b></div>
    <div>cold-init: <b>${stats.coldInitMs?.toFixed(2) ?? "-"} ms</b></div>
    <div>BOSL2 source vendored: <b>${stats.bosl2FileCount ?? "-"} files, ${fmtBytes(stats.bosl2SourceBytes)}</b></div>
    <div>manifold backend probe: <b>${
      stats.manifoldProbe
        ? stats.manifoldProbe.ok
          ? `OK (${stats.manifoldProbe.ms.toFixed(2)} ms)`
          : `FAILED — ${stats.manifoldProbe.stderr.slice(0, 300)}`
        : "-"
    }</b></div>
    <table>
      <thead><tr><th>#</th><th>result</th><th>render ms</th><th>wasm heap bytes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div>all renders ok: <b>${stats.allOk ?? "-"}</b></div>
  `;
  // Also mirror to console as JSON so headless/CI capture can grep it.
  console.log("SPIKE_STATS_JSON", JSON.stringify(stats));
}
render();

const worker = new Worker(new URL("./worker/openscad.worker.ts", import.meta.url), {
  type: "module",
});

const loader = new STLLoader();

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.type) {
    case "status":
      stats.status = msg.message;
      break;
    case "cold-init":
      stats.status = "cold-init complete";
      stats.coldInitMs = msg.coldInitMs;
      stats.bosl2SourceBytes = msg.bosl2SourceBytes;
      stats.bosl2FileCount = msg.bosl2FileCount;
      break;
    case "manifold-probe":
      stats.manifoldProbe = { ok: msg.ok, ms: msg.ms, stderr: msg.stderr };
      break;
    case "reuse-attempt":
      console.log(
        "REUSE_ATTEMPT",
        JSON.stringify({ ok: msg.ok, stderr: msg.stderr }),
      );
      break;
    case "render":
      stats.status = `rendered ${msg.index + 1}/10`;
      stats.renders.push({
        index: msg.index,
        ok: msg.ok,
        ms: msg.ms,
        wasmHeapBytes: msg.wasmHeapBytes,
      });
      if (!msg.ok) {
        console.error(`RENDER_FAIL_STDERR[${msg.index}]`, msg.stderr);
      }
      break;
    case "mesh": {
      const geometry = loader.parse(msg.stl as ArrayBuffer);
      geometry.computeVertexNormals();
      geometry.center();
      const material = new THREE.MeshStandardMaterial({ color: 0x66ccff, flatShading: false });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      break;
    }
    case "done":
      stats.status = "done";
      stats.done = true;
      stats.allOk = msg.allOk;
      break;
    case "fatal":
      stats.status = `FATAL: ${msg.message}`;
      console.error("worker fatal", msg.message);
      break;
  }
  render();
};

worker.onerror = (err) => {
  stats.status = `worker error: ${err.message}`;
  render();
  console.error("worker error", err);
};
