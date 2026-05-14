const fs = require('fs');
const path = require('path');

function patchDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      patchDir(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.mjs') || fullPath.endsWith('.cjs')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let modified = false;

      // 1. Replace all literal import.meta to avoid Metro AST parse errors
      if (content.includes('import.meta')) {
        content = content.replace(/\bimport\.meta\b/g, '({url:"file:///"})');
        modified = true;
      }

      // 2. Hide dynamic imports from Metro
      const dynamicImportRegex = /import\(\/\*webpackIgnore:true\*\/\s*\/\*@vite-ignore\*\/\s*a\)/g;
      if (dynamicImportRegex.test(content)) {
        content = content.replace(dynamicImportRegex, "(0,eval)('import(\"'+a+'\")')");
        modified = true;
      }

      if (modified) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log('Patched:', fullPath);
      }
    }
  }
}

patchDir(path.join(__dirname, 'node_modules', 'onnxruntime-web'));
patchDir(path.join(__dirname, 'node_modules', '@huggingface', 'transformers'));
console.log('Patching complete.');
