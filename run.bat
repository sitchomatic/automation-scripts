@echo off
echo Loading environment from .env...

REM Load variables from .env file
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    set "%%a=%%b"
)

echo.
echo Starting GUI dashboard server...
echo Open http://localhost:3000 in your browser
echo.
npx tsx server.ts

pause
