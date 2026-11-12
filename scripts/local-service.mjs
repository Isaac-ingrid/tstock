import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(SCRIPT_DIR, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const IS_WIN = process.platform === 'win32';
const FRONTEND_URL = 'http://localhost:3000';
const BACKEND_URL = 'http://127.0.0.1:18765';

const SERVICES = {
  backend: {
    key: 'backend',
    name: 'FastAPI 行情后端',
    port: 18765,
    pidFile: path.join(LOGS_DIR, 'backend.pid'),
    logFile: path.join(LOGS_DIR, 'backend.log'),
    cmdPattern: /backend\.app:app/i,
    probe: probeBackend,
    prepare: () => resolvePythonExe(),
    buildLaunchSpec: () => ({
      cwd: ROOT,
      command: resolvePythonExe(),
      args: ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '18765', '--reload'],
    }),
    readyTimeoutMs: 20000,
  },
  frontend: {
    key: 'frontend',
    name: 'Next.js 前端工作台',
    port: 3000,
    pidFile: path.join(LOGS_DIR, 'frontend.pid'),
    logFile: path.join(LOGS_DIR, 'frontend.log'),
    cmdPattern: /next[/\\]dist[/\\]bin[/\\]next|tstock.*next/i,
    probe: probeFrontend,
    prepare: () => ensureFrontendPrereqs(),
    buildLaunchSpec: () => ({
      cwd: ROOT,
      command: process.execPath,
      args: [resolveNextBin(), 'dev', '--hostname', '0.0.0.0'],
    }),
    readyTimeoutMs: 30000,
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pidFile, pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${pid}\n`, 'utf8');
}

function removeQuiet(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // 忽略被占用或已删除的残留文件
  }
}

function readTail(filePath, lines = 25) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return '';
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function checkTcpPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function httpGetLocal(port, reqPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: '' });
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

async function probeBackend() {
  const res = await httpGetLocal(18765, '/health', 2000);
  if (!res.ok) return { healthy: false };
  try {
    const data = JSON.parse(res.body);
    return {
      healthy: data?.ok === true && data?.service === 'tstock-data',
      detail: res.body.trim(),
    };
  } catch {
    return { healthy: false };
  }
}

async function probeFrontend() {
  const res = await httpGetLocal(3000, '/', 3000);
  if (!res.ok) return { healthy: false };
  const isTstock = /做T执行台|七格箱体/i.test(res.body);
  return { healthy: isTstock, foreign: !isTstock };
}

function resolvePythonExe() {
  const candidates = IS_WIN
    ? [path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe')]
    : [path.join(ROOT, 'backend', '.venv', 'bin', 'python')];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    '未找到 backend/.venv 虚拟环境。请先在项目根目录执行：cd backend && uv venv --python 3.12 && uv pip install -r requirements.txt'
  );
}

function resolveNextBin() {
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextBin)) {
    throw new Error('未找到 node_modules/next，请先在项目根目录执行：npm install');
  }
  return nextBin;
}

function ensureFrontendPrereqs() {
  const envLocal = path.join(ROOT, '.env.local');
  const envExample = path.join(ROOT, '.env.example');
  if (!fs.existsSync(envLocal) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envLocal);
    console.log('ℹ️ 已自动从 .env.example 生成 .env.local');
  }

  resolveNextBin();

  // 同步最新 data/ 到 public/data/，保持与 npm run dev 一致
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-static.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // 异常重启后若遗留未占用的 .next/dev/lock，主动清理以免阻塞启动
  removeQuiet(path.join(ROOT, '.next', 'dev', 'lock'));
}

function findListeningPids(port) {
  if (!IS_WIN) {
    try {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out
        .split(/\r?\n/)
        .map((v) => Number.parseInt(v.trim(), 10))
        .filter((v) => Number.isInteger(v) && v > 0);
    } catch {
      return [];
    }
  }

  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    const portSuffix = `:${port}`;
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      if (parts[3] !== 'LISTENING') continue;
      if (!parts[1].endsWith(portSuffix)) continue;
      const pid = Number.parseInt(parts[4], 10);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

function getProcessInfo(pid) {
  if (!IS_WIN) return { commandLine: '', parentPid: null };
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) return { commandLine: '', parentPid: null };
    const info = JSON.parse(raw);
    return {
      commandLine: String(info.CommandLine || ''),
      parentPid: Number.isInteger(info.ParentProcessId) ? info.ParentProcessId : null,
    };
  } catch {
    return { commandLine: '', parentPid: null };
  }
}

function killProcessTree(pid) {
  if (!isPidAlive(pid)) return;
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
      });
      return;
    } catch {
      // 回退到 Node 原生 kill
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 忽略已退出进程
  }
}

/**
 * Windows 下通过 WScript.Shell 以 SW_HIDE(0) 创建带隐藏控制台的后台宿主：
 * 子进程与孙进程(uvicorn reloader、next dev fork、timing_task 定时脚本)共享该隐藏控制台，
 * 避免 detached:true 无控制台时系统为子进程额外弹出可见黑框。
 */
function launchViaHiddenHost(tag) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const vbsPath = path.join(LOGS_DIR, `_launch_${tag}_${process.pid}.vbs`);
  const quoteVbs = (s) => s.replace(/"/g, '""');
  const cmdLine = `"${process.execPath}" "${THIS_FILE}" __bg ${tag}`;
  const vbsContent = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${quoteVbs(ROOT)}"`,
    `shell.Run "${quoteVbs(cmdLine)}", 0, False`,
  ].join('\r\n');

  fs.writeFileSync(vbsPath, vbsContent, 'ascii');
  try {
    execFileSync('wscript.exe', ['//B', '//Nologo', vbsPath], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
  } finally {
    removeQuiet(vbsPath);
  }
}

function getBgTarget(tag) {
  if (tag === 'scheduler') {
    const today = new Date().toISOString().slice(0, 10);
    return {
      cwd: path.join(ROOT, 'timing_task'),
      command: process.execPath,
      args: [path.join(ROOT, 'timing_task', 'scheduler.js')],
      pidFile: null, // scheduler.js 自行维护 timing_task/scheduler.pid
      logFile: path.join(ROOT, 'timing_task', 'logs', `daemon_${today}.log`),
      logMode: 'a',
    };
  }
  const svc = SERVICES[tag];
  if (!svc) throw new Error(`未知后台服务标识: ${tag}`);
  const spec = svc.buildLaunchSpec();
  return {
    cwd: spec.cwd || ROOT,
    command: spec.command,
    args: spec.args,
    pidFile: svc.pidFile,
    logFile: svc.logFile,
    logMode: 'w',
  };
}

function runBgHost(tag) {
  const target = getBgTarget(tag);
  fs.mkdirSync(path.dirname(target.logFile), { recursive: true });
  const logFd = fs.openSync(target.logFile, target.logMode);
  if (target.pidFile) {
    writePid(target.pidFile, process.pid);
  }

  let child;
  try {
    child = spawn(target.command, target.args, {
      cwd: target.cwd,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
  } finally {
    fs.closeSync(logFd);
  }

  const cleanupPid = () => {
    if (target.pidFile && readPid(target.pidFile) === process.pid) {
      removeQuiet(target.pidFile);
    }
  };

  child.on('error', (err) => {
    try {
      fs.appendFileSync(target.logFile, `\n[local-service] 启动异常: ${err.message}\n`, 'utf8');
    } catch {}
    cleanupPid();
    process.exit(1);
  });

  child.on('exit', (code) => {
    cleanupPid();
    process.exit(code ?? 0);
  });

  const forwardStop = () => {
    try {
      child.kill('SIGTERM');
    } catch {}
  };
  process.on('SIGINT', forwardStop);
  process.on('SIGTERM', forwardStop);
}

async function waitForPidFile(pidFile, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid(pidFile);
    if (pid && isPidAlive(pid)) return pid;
    await sleep(100);
  }
  return readPid(pidFile);
}

async function startService(svc) {
  const probeBefore = await svc.probe();
  if (probeBefore.healthy) {
    console.log(`🟡 ${svc.name} 已在运行 (:${svc.port})`);
    return { started: false, alreadyRunning: true };
  }

  if (await checkTcpPort(svc.port)) {
    throw new Error(
      `${svc.name} 所需端口 ${svc.port} 已被其他程序占用，请先释放该端口后再启动。`
    );
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  svc.prepare();
  removeQuiet(svc.pidFile);

  let hostPid;
  if (IS_WIN) {
    launchViaHiddenHost(svc.key);
    hostPid = await waitForPidFile(svc.pidFile, 4000);
  } else {
    const spec = svc.buildLaunchSpec();
    const logFd = fs.openSync(svc.logFile, 'w');
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd || ROOT,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.unref();
    hostPid = child.pid;
    if (hostPid) writePid(svc.pidFile, hostPid);
  }

  console.log(`🚀 正在启动 ${svc.name} (PID: ${hostPid || '启动中'}, 端口: ${svc.port})...`);

  const deadline = Date.now() + svc.readyTimeoutMs;
  while (Date.now() < deadline) {
    const currentPid = hostPid || readPid(svc.pidFile);
    if (currentPid && !isPidAlive(currentPid)) {
      const tail = readTail(svc.logFile);
      throw new Error(
        `${svc.name} 启动后提前退出。\n日志 (${svc.logFile}):\n${tail || '(无日志输出)'}`
      );
    }
    const probe = await svc.probe();
    if (probe.healthy) {
      console.log(`✅ ${svc.name} 已就绪 (:${svc.port})`);
      return { started: true, pid: currentPid };
    }
    await sleep(400);
  }

  const tail = readTail(svc.logFile);
  throw new Error(
    `${svc.name} 在 ${svc.readyTimeoutMs / 1000} 秒内未通过健康检查。\n日志 (${svc.logFile}):\n${tail || '(无日志输出)'}`
  );
}

async function startScheduler() {
  const pidFile = path.join(ROOT, 'timing_task', 'scheduler.pid');
  const existingPid = readPid(pidFile);
  if (existingPid && isPidAlive(existingPid)) {
    console.log(`🟡 定时任务调度器已在运行 (PID: ${existingPid})`);
    return;
  }

  if (IS_WIN) {
    removeQuiet(pidFile);
    console.log('🚀 正在后台启动 A股做T执行台定时调度服务...');
    launchViaHiddenHost('scheduler');
    const pid = await waitForPidFile(pidFile, 5000);
    if (!pid || !isPidAlive(pid)) {
      throw new Error('定时任务调度器启动未就绪，请检查 timing_task/logs/daemon_*.log');
    }
    console.log(`✅ 调度服务已成功在后台运行 (PID: ${pid})！`);
    return;
  }

  execFileSync(process.execPath, [path.join(ROOT, 'timing_task', 'start.js'), '--daemon'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

async function stopService(svc) {
  let stoppedAny = false;
  const savedPid = readPid(svc.pidFile);
  if (savedPid && isPidAlive(savedPid)) {
    console.log(`🛑 正在停止 ${svc.name} (PID: ${savedPid})...`);
    killProcessTree(savedPid);
    stoppedAny = true;
  }
  removeQuiet(svc.pidFile);

  // 处理手动启动或 uvicorn/next 子进程残留占端口的情况
  const portPids = findListeningPids(svc.port);
  for (const pid of portPids) {
    const info = getProcessInfo(pid);
    const parentInfo = info.parentPid ? getProcessInfo(info.parentPid) : { commandLine: '' };
    const probe = await svc.probe();
    const matchParent = parentInfo.commandLine && svc.cmdPattern.test(parentInfo.commandLine);
    const matchSelf = info.commandLine && svc.cmdPattern.test(info.commandLine);
    if (probe.healthy || matchSelf || matchParent) {
      const targetPid = matchParent ? info.parentPid : pid;
      console.log(`🛑 清理端口 ${svc.port} 关联进程树 (PID: ${targetPid})...`);
      killProcessTree(targetPid);
      stoppedAny = true;
    }
  }

  if (stoppedAny) {
    for (let i = 0; i < 15; i += 1) {
      if (!(await checkTcpPort(svc.port, '127.0.0.1', 200))) break;
      await sleep(200);
    }
    console.log(`✅ ${svc.name} 已停止`);
  } else {
    console.log(`⚪ ${svc.name} 当前未运行`);
  }
}

function stopScheduler() {
  execFileSync(process.execPath, [path.join(ROOT, 'timing_task', 'stop.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function openBrowser(url) {
  if (!IS_WIN) return;
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function printStatus() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('📊 A股做T工作台 · 本机服务状态');
  console.log('════════════════════════════════════════════════════════════');

  for (const svc of Object.values(SERVICES)) {
    const pid = readPid(svc.pidFile);
    const pidAlive = pid ? isPidAlive(pid) : false;
    const probe = await svc.probe();
    const listeningPids = findListeningPids(svc.port);
    const state = probe.healthy
      ? `🟢 运行中 (端口 :${svc.port}${pidAlive ? `, PID ${pid}` : listeningPids.length ? `, 监听 PID ${listeningPids.join('/')}` : ''})`
      : listeningPids.length
        ? `🟠 端口 :${svc.port} 被其他进程占用 (PID ${listeningPids.join('/')})`
        : '⚪ 未运行';
    console.log(`  · ${svc.name.padEnd(18, ' ')} -> ${state}`);
  }

  console.log('');
  execFileSync(process.execPath, [path.join(ROOT, 'timing_task', 'status.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '__bg') {
    runBgHost(args[1]);
    return;
  }

  let action = args.find((a) => !a.startsWith('-')) || 'start';
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  if (flags.has('--restart') || flags.has('-r')) {
    action = 'restart';
  }
  const noOpen = flags.has('--no-open');
  const noTimer = flags.has('--no-timer');

  if (action === 'status') {
    await printStatus();
    return;
  }

  if (action === 'stop') {
    await stopService(SERVICES.frontend);
    await stopService(SERVICES.backend);
    if (!noTimer) stopScheduler();
    return;
  }

  if (action === 'restart') {
    await stopService(SERVICES.frontend);
    await stopService(SERVICES.backend);
    if (!noTimer) stopScheduler();
  } else if (action !== 'start') {
    console.error(`未知操作: ${action}（支持 start | stop | restart | status）`);
    process.exit(2);
  }

  await startService(SERVICES.backend);
  await startService(SERVICES.frontend);
  if (!noTimer) {
    await startScheduler();
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('🎉 A股做T工作台本机环境已全部就绪！');
  console.log(`   · 前端页面: ${FRONTEND_URL}`);
  console.log(`   · 行情后端: ${BACKEND_URL}/health`);
  console.log(`   · 运行日志: ${LOGS_DIR}`);
  console.log('   · 停止命令: .\\stop.bat 或 npm run stop:local');
  console.log('════════════════════════════════════════════════════════════');

  if (!noOpen) {
    openBrowser(FRONTEND_URL);
  }
}

main().catch((err) => {
  console.error(`\n❌ 启动失败: ${err.message}`);
  process.exit(1);
});
