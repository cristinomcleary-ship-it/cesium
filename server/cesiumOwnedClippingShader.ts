import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin } from 'vite';
import { OWNED_FRAGMENT_CLIPPING } from '../src/ownedClippingPolygons.ts';

// Cesium 1.144.0 / @cesium/engine 26.2.0. This adapter intentionally fails on
// dependency changes: revalidate GPU coverage/performance before updating it.
export const CLIPPING_PIPELINE_SHA256 = '65a565028830337327426e0f98ccc37a379a502556489342610aee732c27dbe7';
const revalidationMessage = ' Revalidate the owned clipping adapter against the locked Cesium dependency before upgrading.';
const moduleSuffix = '/@cesium/engine/Source/Scene/Model/ModelClippingPolygonsPipelineStage.js';
export function isCesiumClippingPipeline(id: string): boolean {
  return id.replace(/\\/g, '/').endsWith('/node_modules' + moduleSuffix);
}

/** Region selection must happen at the fragment. The upstream flat vertex region
 * drops fragments of large photography triangles whose vertices are outside the
 * atlas extent. Do not enlarge atlas extents: that loses boundary precision. */
export const OWNED_CLIPPING_FRAGMENT_SHADER = `void modelClippingPolygonsStage()
{
    vec2 spherical = czm_approximateSphericalCoordinates(v_positionWC);
    spherical.y = czm_branchFreeTernary(spherical.y < czm_pi, spherical.y, spherical.y - czm_twoPi);
    int region = -1;
    vec2 clip = vec2(czm_infinity);
    for (int i = 0; i < CLIPPING_POLYGON_REGIONS_LENGTH; i++) {
        vec4 extent = czm_unpackClippingExtents(model_clippingExtents, i);
        vec2 uv = (spherical.yx - extent.yx) * extent.wz;
        if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
            region = i;
            clip = uv;
            break;
        }
    }
    czm_clipPolygons(model_clippingDistance, CLIPPING_POLYGON_REGIONS_LENGTH, clip, region);
}
`;

export function transformCesiumClippingPipeline(source: string): string {
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== CLIPPING_PIPELINE_SHA256) throw new Error('Unsupported Cesium clipping pipeline SHA-256: ' + hash + revalidationMessage);
  const uniform = '"model_clippingExtents",\n    ShaderDestination.VERTEX,';
  const fragment = 'shaderBuilder.addFragmentLines(ModelClippingPolygonsStageFS);';
  const collection = 'const clippingPolygons = model.clippingPolygons;';
  for (const needle of [uniform, fragment, collection]) {
    if (source.split(needle).length !== 2) throw new Error('Cesium clipping adapter signature is not unique');
  }
  return source
    .replace(collection, collection + '\n  const platformOwnedClipping = Object.hasOwn(clippingPolygons, ' + JSON.stringify(OWNED_FRAGMENT_CLIPPING) + ') && clippingPolygons[' + JSON.stringify(OWNED_FRAGMENT_CLIPPING) + '] === true;')
    .replace(uniform, '"model_clippingExtents",\n    platformOwnedClipping ? ShaderDestination.BOTH : ShaderDestination.VERTEX,')
    .replace(fragment, 'shaderBuilder.addFragmentLines(platformOwnedClipping ? ' + JSON.stringify(OWNED_CLIPPING_FRAGMENT_SHADER) + ' : ModelClippingPolygonsStageFS);');
}

function checkedTransform(source: string, id: string): string {
  const normalized = id.replace(/\\/g, '/');
  const engineRoot = normalized.slice(0, normalized.indexOf('/Source/Scene/Model/ModelClippingPolygonsPipelineStage.js'));
  const version = JSON.parse(readFileSync(engineRoot + '/package.json', 'utf8')).version;
  if (version !== '26.2.0') throw new Error('Unsupported Cesium engine version: ' + version + revalidationMessage);
  return transformCesiumClippingPipeline(source);
}

/** Vite production/non-optimized modules and development's dependency optimizer
 * must share exactly the same adapter. No SDK file or dependency is modified. */
export function cesiumOwnedClippingShaderPlugin(): Plugin {
  // Validate even with a warm optimizer cache. Vite hashes plugin names, not hook
  // bodies, so include the transformed module content in both pipeline names.
  const require = createRequire(import.meta.url);
  const engineEntry = createRequire(require.resolve('cesium')).resolve('@cesium/engine');
  const pipelinePath = resolve(dirname(engineEntry), 'Source/Scene/Model/ModelClippingPolygonsPipelineStage.js');
  const transformed = checkedTransform(readFileSync(pipelinePath, 'utf8'), pipelinePath);
  const name = 'cesium-owned-fragment-clipping-' + createHash('sha256').update(transformed).digest('hex').slice(0, 16);
  const optimizer: EsbuildPlugin = {
    name,
    setup(build) {
      build.onLoad({ filter: /ModelClippingPolygonsPipelineStage\.js$/ }, args => {
        if (!isCesiumClippingPipeline(args.path)) return undefined;
        return { contents: checkedTransform(readFileSync(args.path, 'utf8'), args.path), loader: 'js' };
      });
    },
  };
  return {
    name,
    enforce: 'pre',
    config() { return { optimizeDeps: { esbuildOptions: { plugins: [optimizer] } } }; },
    transform(source, id) {
      if (!isCesiumClippingPipeline(id)) return undefined;
      return { code: checkedTransform(source, id), map: null };
    },
  };
}
