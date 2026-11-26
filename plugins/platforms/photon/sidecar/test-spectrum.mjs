export * from './node_modules/spectrum-ts/dist/index.js';
export async function Spectrum() { return {messages: {async *[Symbol.asyncIterator]() { await new Promise(()=>{}); }}, stop: async()=>{}}; }
