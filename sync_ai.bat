@echo off
color 0A

echo ========================================================
echo  SINCRONIZZAZIONE PROGETTO PER AI STUDIO
echo ========================================================

:: --- PERCORSI ---
set "source=%~dp0"
set "source=%source:~0,-1%"
set "dest=G:\Il mio Drive\AI_Projects\GestionenaleDB_Mirror"

:: --- ESECUZIONE ---
echo Copia in corso da:
echo %source%
echo a:
echo %dest%
echo.

:: --- COMANDO ROBOCOPY ---
robocopy "%source%" "%dest%" /MIR /R:1 /W:1 ^
*.js *.json *.txt *.html *.css *.md ^
/XD node_modules .git .vscode archivio_files documenti ^
/XF database.db package-lock.json *.log .env

echo.
echo ========================================================
if %ERRORLEVEL% LEQ 8 (
    echo  SUCCESSO! File aggiornati su Google Drive.
    echo  Ora puoi selezionare la cartella "GestionenaleDB_Mirror"
    echo  da Google AI Studio.
) else (
    echo  ERRORE durante la copia.
)
echo ========================================================
timeout /t 5
