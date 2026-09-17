# MAXICONFORT — Installation de l'agent d'impression GLS
#
# 1. Raccourci dans le dossier "Demarrage" de la session : l'agent demarre a l'ouverture de session.
# 2. Tache planifiee "Maxiconfort - Impression GLS (surveillance)" toutes les 5 minutes : relance
#    l'agent s'il s'est arrete (mise a jour d'une appli, plantage, fermeture par erreur...).
#    Le lanceur VBS ne fait rien si l'agent tourne deja → jamais de doublon.
# 3. Demarre l'agent tout de suite VIA LA TACHE PLANIFIEE (et pas depuis ce script) : ainsi
#    l'agent n'est l'enfant d'aucune application. Le 17/09/2026, lance depuis une session Claude,
#    il avait ete ferme a 7h21 par la mise a jour automatique de l'appli Claude.
# Aucun droit administrateur necessaire.
#
# Installer  :  powershell -ExecutionPolicy Bypass -File print-agent\config\installer-agent.ps1
# Retirer    :  schtasks /delete /tn "Maxiconfort - Impression GLS (surveillance)" /f
#               + supprimer "Maxiconfort - Impression GLS.lnk" dans shell:startup
# Arreter    :  retirer la tache (sinon elle le relance), puis terminer le node.exe dont la ligne de
#               commande contient "agent-impression.js" (ne pas tuer le bot Telegram scripts\bot.js !)

$nom = "Maxiconfort - Impression GLS"
$nomTache = "$nom (surveillance)"
$lanceur = "C:\Users\moind\maxiconfort-livraison\print-agent\config\lancer-agent-cache.vbs"

if (-not (Test-Path $lanceur)) { Write-Output "Fichier de lancement introuvable : $lanceur"; exit 1 }

# 1. Raccourci de demarrage
$raccourci = Join-Path ([Environment]::GetFolderPath('Startup')) "$nom.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($raccourci)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$lanceur`""
$lnk.WorkingDirectory = "C:\Users\moind\maxiconfort-livraison"
$lnk.Description = "Imprime automatiquement les etiquettes GLS creees dans l'app Livraison"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Output "Raccourci de demarrage : OK"

# 2. Tache de surveillance toutes les 5 minutes
schtasks /create /tn "$nomTache" /tr "wscript.exe `"$lanceur`"" /sc minute /mo 5 /f | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "ECHEC creation de la tache de surveillance (code $LASTEXITCODE)"; exit 2 }
Write-Output "Tache de surveillance (toutes les 5 min) : OK"

# 3. Demarrage immediat par le planificateur (parent = Planificateur de taches, pas ce script)
schtasks /run /tn "$nomTache" | Out-Null
Start-Sleep -Seconds 6
$agent = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-impression.js*' }
if ($agent) { Write-Output "Agent en cours d'execution (PID $($agent.ProcessId)). Journal : print-agent\journal\" }
else { Write-Output "ATTENTION : l'agent n'a pas demarre. Voir print-agent\journal\lanceur.log" }
