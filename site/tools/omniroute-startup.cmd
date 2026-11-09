@echo off
rem Starts OmniRoute for Rosalena on 127.0.0.1:20128, hidden (no window in the taskbar).
rem Rosalena now starts OmniRoute by itself, inside the app, whenever the app is open
rem (Settings > Cloud models). This file is only for keeping it up while Rosalena is closed,
rem for the website's tunnel: copy it into the Startup folder (Win+R, shell:startup) for
rem every sign-in, delete the copy to undo. Rosalena's "Run it inside Rosalena" takes over a
rem copy started here.
rem Loopback only: without PORT/HOSTNAME it would listen on 0.0.0.0:3000, the whole network.
rem Edit the path below if OmniRoute lives somewhere else (Settings > Cloud models installs
rem it under %USERPROFILE%\.rosalena\omniroute).
set PORT=20128
set HOSTNAME=127.0.0.1
set OMNI=D:\Tools\omniroute
rem Start-Process without redirection gives node a console of its own, hidden: with
rem -RedirectStandardOutput it would share this script's console and die when it closed.
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList '\"%OMNI%\node_modules\omniroute\bin\omniroute.mjs\" --no-open' -WorkingDirectory '%OMNI%' -WindowStyle Hidden"
