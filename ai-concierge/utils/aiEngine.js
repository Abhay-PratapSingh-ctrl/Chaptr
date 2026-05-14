/**
 * MOVED TO: public/aiWorker.js
 * 
 * Why? 
 * Metro bundler and modern Web Workers (especially those using WebGPU and 
 * complex WASM bindings) conflict aggressively when using the `import.meta.url` syntax.
 * 
 * To ensure your AI engine stays 100% local and bypasses all Metro parsing errors,
 * the Web Worker code was moved to `public/aiWorker.js`. It is now served as a static 
 * asset and loads completely independently from the main React bundle.
 * 
 * Please edit your AI logic inside `public/aiWorker.js` instead!
 */
