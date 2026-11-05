const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('[Build] 正在打包 A股做T执行台 模块化代码到 js/bundle.js...');
const projectRoot = path.resolve(__dirname);
const mainPath = path.join(projectRoot, 'js', 'main.js');
const outPath = path.join(projectRoot, 'js', 'bundle.js');

try {
  execSync(`npx esbuild "${mainPath}" --bundle --outfile="${outPath}" --format=iife --external:https://*`, {
    cwd: projectRoot,
    stdio: 'inherit'
  });
  console.log('✅ 打包成功：js/bundle.js 已生成 (免 CORS，完美支持本地 file:// 双击与云端运行)');
} catch (err) {
  console.error('❌ 打包失败:', err.message);
}
