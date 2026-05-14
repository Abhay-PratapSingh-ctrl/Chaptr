/**
 * AI Engine — Sui AI Concierge (PWA Version)
 * Runs locally in a Web Worker using WebGPU + 8-bit Quantization.
 */
import { pipeline, env } from '/transformers.js';

// 1. Setup Environment for PWA (Browser Cache + No Local FS)
env.allowLocalModels = false;
env.useBrowserCache = true;

// Fix for Metro/import.meta error: Tell ONNX Runtime where to find the WASM files locally
env.backends.onnx.wasm.wasmPaths = '/';

// 2. The Singleton Class (Your Requested Structure)
class AIConciergeEngine {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            // Check for WebGPU support, fallback to WASM
            const supportsWebGPU = typeof navigator !== 'undefined' && navigator.gpu;
            
            // Merged: WebGPU/WASM + Quantization + Progress Updates
            this.instance = await pipeline(this.task, this.model, { 
                device: supportsWebGPU ? 'webgpu' : 'wasm',
                dtype: 'q8',            // 8-bit quantization for low memory
                progress_callback 
            });
        }
        return this.instance;
    }
}

// 3. The Worker Listener (The "Engine Room")
self.addEventListener('message', async (event) => {
    const { text } = event.data;

    try {
        // Initialize or get the cached model instance
        const extractor = await AIConciergeEngine.getInstance((info) => {
            // Send loading/downloading updates back to the UI (index.tsx)
            self.postMessage({ type: 'progress', info });
        });

        // Notify UI that processing is starting
        self.postMessage({ type: 'progress', info: { status: 'ready' } });

        // Generate the Personality Vector
        const output = await extractor(text, {
            pooling: 'mean',
            normalize: true,
        });

        // Convert Tensor to standard JS Array for the Sui Move Object
        const vector = Array.from(output.data);
        
        // Send the final Digital Twin vector back to the UI
        self.postMessage({ type: 'complete', vector });

    } catch (error) {
        console.error("AI Engine Error:", error);
        self.postMessage({ 
            type: 'error', 
            error: error.message || "Failed to generate vector" 
        });
    }
});