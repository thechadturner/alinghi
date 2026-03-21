@echo off
start cmd /k "cd /d C:\MyGit\Rust\InfluxSimulator\target\release && simulator.exe
start "" "http://127.0.0.1:8086/dashboard"
