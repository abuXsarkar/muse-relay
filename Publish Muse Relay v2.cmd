@echo off
setlocal
pushd "%~dp0"
call npx.cmd --yes wrangler@4.168.0 whoami --json | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{process.exit(JSON.parse(s).loggedIn?0:1)}catch{process.exit(1)}})"
if not errorlevel 1 goto deploy
call npx.cmd --yes wrangler@4.168.0 login
if errorlevel 1 goto finish
:deploy
call npm.cmd run deploy
:finish
set "relay_exit=%errorlevel%"
popd
pause
exit /b %relay_exit%
