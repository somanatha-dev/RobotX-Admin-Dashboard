/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RobotRendererRegistry — the future-3D insertion point
 *
 *                        RobotVisual  (+ its RobotWorldAnchor)
 *                              │
 *                     RobotVisualAdapter
 *                              │
 *                    ┌─────────┴─────────┐
 *                    ▼                   ▼
 *          '2d' marker renderer    '3d' robot renderer
 *              (CURRENT)               (FUTURE — absent)
 *
 * Introducing 3D robots later is: write one module implementing the contract
 * below, call `registerRobotRenderer('3d', factory)`, and flip the
 * `representation` a caller asks for. Nothing above this line moves —
 * not telemetry, not robot state, not selection, not the assignment engine,
 * not the coordinate model, not the camera.
 *
 * ── The contract a renderer implements ────────────────────────────────────
 * A renderer is a FACTORY. It is called once with a rendering context and
 * returns an instance that owns the per-robot objects it creates:
 *
 *   factory(context) -> {
 *     representation : string
 *     mount(visual)                -> handle   // create the robot's visual
 *     update(handle, visual)                   // incremental; no re-create
 *     setSelected(handle, selected)            // selection is app state
 *     applyCamera(handle, camera)              // { zoom, pitch, bearing }
 *     destroy(handle)                          // remove one robot
 *     dispose()                                // tear the whole layer down
 *   }
 *
 * `handle` is opaque to every caller. Nothing outside a renderer may reach
 * into it — in particular, nobody reads a robot's position back out of it.
 * Position flows one way, from state through the canonical world transform
 * (`world/robotWorldAnchor.js`) into the renderer, and never back.
 *
 * `context` is whatever the host rendering stack needs. Today: `{ getMap }`.
 * A future 3D renderer would receive the same object and reach for a scene
 * handle off it rather than a fresh one of its own.
 *
 * ── Why the registry is pure ──────────────────────────────────────────────
 * No `mapbox-gl`, no React, no `@/` alias. Renderers self-register on import
 * at the composition point instead of being imported here, which keeps the
 * seam loadable by the architectural test under plain Node — the test proves
 * a 3D renderer drops in without touching state, and it could not do that if
 * resolving a renderer dragged in a WebGL dependency.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { ROBOT_REPRESENTATION } from './robotVisual.js';

/** @type {Map<string, Function>} */
const registry = new Map();

/**
 * Register a renderer factory under a representation name.
 * Re-registering the same name replaces it (module re-evaluation under HMR).
 */
export function registerRobotRenderer(representation, factory) {
  const name = String(representation || '').trim();
  if (!name) throw new Error('registerRobotRenderer: representation name is required');
  if (typeof factory !== 'function') {
    throw new Error(`registerRobotRenderer("${name}"): factory must be a function`);
  }
  registry.set(name, factory);
  return () => {
    if (registry.get(name) === factory) registry.delete(name);
  };
}

/** Names with a renderer registered right now. */
export function listRobotRepresentations() {
  return [...registry.keys()];
}

export function hasRobotRenderer(representation) {
  return registry.has(String(representation || '').trim());
}

/**
 * Resolve a renderer factory by representation name.
 *
 * Asking for `'3d'` today throws deliberately and says exactly what is
 * missing. A silent fallback to the 2D marker would be worse: it would let a
 * half-finished 3D migration look like it worked.
 */
export function resolveRobotRenderer(representation) {
  const name = String(representation || '').trim();
  const factory = registry.get(name);
  if (factory) return factory;

  if (name === ROBOT_REPRESENTATION.THREE_D) {
    throw new Error(
      'No robot renderer registered for representation "3d". This is the ' +
        'documented future insertion point: implement the renderer contract in ' +
        'features/maps/operational/renderers/ and call registerRobotRenderer("3d", factory). ' +
        'Robot state, telemetry, selection, the world transform and the camera do not change.'
    );
  }

  throw new Error(
    `No robot renderer registered for representation "${name}". ` +
      `Registered: [${listRobotRepresentations().join(', ') || 'none'}]`
  );
}

/**
 * Create a renderer instance and assert it satisfies the contract. Catching a
 * missing method here — at wire-up — beats discovering it on the first
 * telemetry tick of a live fleet view.
 */
export function createRobotRenderer(representation, context) {
  const instance = resolveRobotRenderer(representation)(context);
  for (const method of ['mount', 'update', 'setSelected', 'applyCamera', 'destroy', 'dispose']) {
    if (typeof instance?.[method] !== 'function') {
      throw new Error(
        `Robot renderer "${representation}" does not satisfy the renderer contract: missing ${method}()`
      );
    }
  }
  return instance;
}
