@echo off
chcp 65001 >nul
title A股做T执行台本地开发服务 (支持原生ESM模块与Anime.js)
echo ============================================================
echo   A股做T执行台 · 本地轻量HTTP服务已启动
echo   本地访问地址: http://localhost:8888
echo   原生ESM模块与Anime.js动效完全就绪 (无CORS限制)
echo ============================================================
start "" "http://localhost:8888"
node -e "const http=require('http'),fs=require('fs'),path=require('path');const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};http.createServer((req,res)=>{let f=path.join(__dirname,decodeURIComponent(req.url.split('?')[0]));if(f===__dirname)f=path.join(__dirname,'index.html');if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');fs.readFile(f,(err,data)=>{if(err){res.writeHead(404);res.end('404 Not Found');return;}res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'text/plain','Access-Control-Allow-Origin':'*'});res.end(data);});}).listen(8888,()=>console.log('HTTP服务运行在 http://localhost:8888'));"
pause
