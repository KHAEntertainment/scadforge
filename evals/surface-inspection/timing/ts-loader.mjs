// Minimal Node ESM resolution hook: `apps/web`'s TypeScript sources import
// sibling modules by their emitted-JS specifier (e.g. `./thresholds.js`),
// the standard `nodenext` convention — resolved by tsc/Vite's bundler
// resolution, but not by plain Node, which looks for a literal `.js` file
// and fails. This hook retries any failed `.js` specifier as `.ts` before
// giving up. Registered by `measure-inspect.mjs` via `module.register()`;
// not a project dependency (no tsx/ts-node) — this repo's own timing
// script needs nothing more than this to import the real inspect/ modules
// under `node --experimental-strip-types`.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js") && err?.code === "ERR_MODULE_NOT_FOUND") {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
