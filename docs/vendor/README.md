# Vendored browser dependencies

`motion-mini-12.43.0.js` is a browser-only bundle of Motion's `mini` entry
point. It is kept local so the standalone GitHub Pages site has no runtime CDN
dependency and the OpenMergeLens CLI's package dependencies remain unchanged.

- Package: [`motion@12.43.0`](https://www.npmjs.com/package/motion/v/12.43.0)
- Source entry point: `motion/dist/es/mini.mjs`
- Bundler: `esbuild@0.21.5`
- Build options: `--bundle --minify --format=esm --legal-comments=inline`
- SHA-256: `7cc8377131e61e5610f0314dc0d8ac1d2a9ee47e3218f0a35029cbaebc52d5bf`
- License: [MIT](./MOTION-LICENSE.md)

When updating Motion, regenerate the bundle from a clean temporary install,
update the versioned filename and import, copy the upstream license, and
replace the checksum above.
