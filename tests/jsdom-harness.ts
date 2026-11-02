import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import ts from 'typescript';

/**
 * Render a component from this repo in a DOM, without a bundler.
 *
 * The test runner strips types but not JSX, so a `.tsx` module cannot be imported by it directly.
 * TypeScript is already a dev dependency, so the harness transpiles on the way in and resolves the
 * component's own imports itself. Anything the component pulls from the plugin SDK is stubbed: a
 * render test is about what the owner sees, not about the host around it.
 */
export function loadComponent(entry: string, stubs: Record<string, unknown> = {}): Record<string, any> {
  const require_ = createRequire(import.meta.url);
  const loaded = new Map<string, unknown>();

  function load(file: string): any {
    if (loaded.has(file)) return loaded.get(file);
    const source = readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const module: { exports: any } = { exports: {} };
    loaded.set(file, module.exports);
    const localRequire = (spec: string): unknown => {
      if (spec in stubs) return stubs[spec];
      if (spec.endsWith('.css')) return {};
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const base = path.resolve(path.dirname(file), spec);
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.tsx`.replace(/\.ts$/, ''), path.join(base, 'index.ts')]) {
          try {
            return load(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        throw new Error(`cannot resolve ${spec} from ${file}`);
      }
      return require_(spec);
    };
    new Function('exports', 'require', 'module', js)(module.exports, localRequire, module);
    loaded.set(file, module.exports);
    return module.exports;
  }

  return load(path.resolve(entry));
}
