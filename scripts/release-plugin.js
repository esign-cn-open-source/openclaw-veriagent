#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const target = process.argv[2] || 'public';
const registries = {
  private: process.env.VERIAGENT_PRIVATE_NPM_REGISTRY || 'https://registry-npm.tsign.cn/',
  public: process.env.VERIAGENT_PUBLIC_NPM_REGISTRY || 'https://registry.npmjs.org/',
};

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!registries[target]) {
  console.error(`Unsupported release target: ${target}`);
  console.error('Use one of: private, public');
  process.exit(1);
}

const registry = registries[target];
const publishArgs = ['publish', '--registry', registry];

if (target === 'public' && packageJson.name.startsWith('@')) {
  publishArgs.push('--access', 'public');
}

console.log(`Preparing ${packageJson.name}@${packageJson.version} for ${target}`);
console.log(`Registry: ${registry}`);
console.log('Step 1/2: verify package contents');
run('npm', ['pack', '--dry-run']);

console.log('Step 2/2: publish package');
run('npm', publishArgs);
