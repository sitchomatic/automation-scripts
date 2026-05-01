@echo off
echo Setting environment variables...
set BROWSERBASE_API_KEY=bb_live_l-0TlPTGcIX7Ej-1e4lOaoqBOqQ
set BROWSERBASE_PROJECT_ID=cd060316-4ca4-49c7-881e-63b9cabd1735

echo.
echo Starting GUI dashboard server...
echo Open http://localhost:3000 in your browser
echo.
npx tsx server.ts

pause
