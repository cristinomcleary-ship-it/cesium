# Private temporary-works asset build

The public code supplies the pipeline. Model files, textures, node bindings, geometry hashes and audit output remain in the owner's private asset package.

Install Node dependencies with `npm ci --prefix tools/temporary-works-assets`. Asset builds also require the **Noto Sans CJK SC** font (Linux: `fonts-noto-cjk`). Prebuilt private GLBs do not require this font on deployment devices.

Place `branding-mapping.json` alongside the original source GLBs, then run:

```sh
node tools/temporary-works-assets/build.mjs /absolute/private-source-directory
node tools/temporary-works-assets/verify.mjs
node --test tools/temporary-works-assets/geometry-signs.test.mjs
```

The optional asset selector and map path follow the source directory:

```sh
node tools/temporary-works-assets/build.mjs /absolute/private-source-directory camp /absolute/private/branding-mapping.json
```

The private map has `schemaVersion: 1`, with `camp` and `steel` entries, each containing `sourceSha256` and a `plan` array. Every plan entry identifies `sourceNode`, `sourceName`, `geometrySha256` and the verified horizontal `normal`; replacement content uses `text` or `logo: true`. Optional `vertical: true` lays out vertical Chinese lettering. Only an independently audited map for the exact source bytes should be used. Missing or mismatched source/geometry hashes stop the build. Do not guess node bindings from an index alone.

The pipeline removes audited old lettering meshes before adding exact text on transparent cutout faces at the measured sign surfaces. The replacements are flat lettering, rather than the former extruded lettering. Source files are never rewritten. The placement datum, dimensions and footprint are measured from the filtered source **before** branding replacement, keeping saved scene placement stable.

Inspect both outward faces, entrance signs, small plaques and textured signs in the resulting GLBs. Validate the final compressed assets and visually accept them in the actual Cesium photogrammetry scene. Offline image review and automated tests do not replace that acceptance.

Never commit the private source, mapping, GLBs, textures, model manifests, generated geometry or model screenshots to a public repository without the owner's explicit authorization.
