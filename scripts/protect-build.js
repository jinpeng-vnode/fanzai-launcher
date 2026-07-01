const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const outDir = path.join(root, '.protected-src');

const jsOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.12,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
};

function copyProtected(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copyProtected(path.join(from, name), path.join(to, name));
    }
    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (from.endsWith('.js')) {
    const code = fs.readFileSync(from, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, jsOptions);
    fs.writeFileSync(to, result.getObfuscatedCode(), 'utf8');
  } else {
    fs.copyFileSync(from, to);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
copyProtected(srcDir, outDir);
console.log(`Protected sources written to ${outDir}`);
