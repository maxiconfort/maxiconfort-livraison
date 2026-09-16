@echo off
REM MAXICONFORT — lanceur de l'agent d'impression GLS
REM Relance automatiquement l'agent s'il s'arrete (coupure reseau, erreur).

cd /d "C:\Users\moind\maxiconfort-livraison"
if not exist print-agent\journal mkdir print-agent\journal

:boucle
echo ===== DEMARRAGE %DATE% %TIME% ===== >> print-agent\journal\lanceur.log
"C:\Program Files\nodejs\node.exe" print-agent\agent-impression.js >> print-agent\journal\lanceur.log 2>&1
echo [%DATE% %TIME%] agent arrete - redemarrage dans 20 secondes >> print-agent\journal\lanceur.log
timeout /t 20 /nobreak > nul
goto boucle
