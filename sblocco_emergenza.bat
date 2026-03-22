@echo off
setlocal enableextensions
title SBLOCCO EMERGENZA DATABASE
color 4f

REM --- 1. Posizionati nella cartella corretta ---
cd /d "%~dp0"

cls
echo ========================================================
echo !!!    PROCEDURA DI SBLOCCO MANUALE DATABASE     !!!
echo ========================================================
echo.
echo  Questo script esegue 3 passaggi:
echo  1. Chiude forzatamente il programma (se bloccato).
echo  2. Elimina il file di sessione.
echo  3. Ripristina il database.
echo.
echo  Premi INVIO per avviare la FASE 0 (Chiusura Processi)...
pause >nul

REM =========================================================
REM FASE 0: KILL DEI PROCESSI
REM =========================================================
cls
echo ========================================================
echo [FASE 0/3] Chiusura forzata processi...
echo ========================================================

taskkill /F /IM "gestionale-pro.exe" /T >nul 2>&1
if %errorlevel% equ 0 (
    echo - Trovato e chiuso 'gestionale-pro.exe'.
) else (
    echo - Nessun processo del gestionale trovato (Bene).
)

REM Uccidiamo anche Node per sicurezza (se stai testando in sviluppo)
taskkill /F /IM "node.exe" /T >nul 2>&1

echo.
echo Fase 0 completata.
echo Attendo 2 secondi che Windows rilasci i file...
timeout /t 2 >nul

echo.
echo Premi INVIO per avviare la FASE 1 (Pulizia Lock)...
pause >nul

REM =========================================================
REM FASE 1: RIMOZIONE session.lock
REM =========================================================
cls
echo ========================================================
echo [FASE 1/3] Controllo file di sessione...
echo ========================================================

if exist "session.lock" (
    del "session.lock"
    echo - File 'session.lock' eliminato con successo.
) else (
    echo - Il file 'session.lock' non c'era (Gia' pulito).
)

echo.
echo Premi INVIO per avviare la FASE 2 (Ripristino DB)...
pause >nul

REM =========================================================
REM FASE 2: RIPRISTINO DATABASE
REM =========================================================
cls
echo ========================================================
echo [FASE 2/3] Ripristino file Database...
echo ========================================================

REM Caso A: Se non c'è il file bloccato.
if not exist "database.db.LOCKED" goto CHECK_NORMAL

REM Caso B: Controllo doppio file.
if exist "database.db" goto ERRORE_DOPPIO

REM Caso C: Rinominare.
echo - Trovato 'database.db.LOCKED'.
echo - Tento di rinominarlo in 'database.db'...

ren "database.db.LOCKED" "database.db"

if %errorlevel% neq 0 (
    goto ERRORE_RINOMINA
) else (
    echo.
    echo [SUCCESSO] Database sbloccato correttamente!
    goto FINE
)

REM =========================================================
REM GESTIONE CASI PARTICOLARI
REM =========================================================

:CHECK_NORMAL
if exist "database.db" (
    echo - Il file 'database.db' e' gia' presente e libero.
    echo   Non serve fare nulla.
) else (
    echo - [ATTENZIONE] Nessun database trovato nella cartella!
    echo   Hai cancellato i file per sbaglio?
)
goto FINE

:ERRORE_DOPPIO
echo.
echo [!!! ERRORE CRITICO !!!]
echo Trovati SIA 'database.db' CHE 'database.db.LOCKED'.
echo.
echo SOLUZIONE MANUALE:
echo 1. Vai nella cartella.
echo 2. Controlla quale file e' piu' recente.
echo 3. Cancellane uno e rinomina l'altro in 'database.db'.
goto FINE

:ERRORE_RINOMINA
echo.
echo [!!! ERRORE WINDOWS !!!]
echo Impossibile rinominare il file anche dopo aver chiuso i processi.
echo.
echo SOLUZIONE:
echo Riavvia il computer e riprova.
goto FINE

REM =========================================================
REM FINE
REM =========================================================
:FINE
echo.
echo ========================================================
echo  OPERAZIONE COMPLETATA
echo ========================================================
echo  Premi un tasto per chiudere la finestra.
pause >nul