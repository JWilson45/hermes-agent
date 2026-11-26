export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'spectrum-ts') return {url:new URL('./test-spectrum.mjs', import.meta.url).href, shortCircuit:true};
  if (specifier === 'spectrum-ts/providers/imessage') return {url:new URL('./test-imessage.mjs', import.meta.url).href, shortCircuit:true};
  return nextResolve(specifier, context);
}
