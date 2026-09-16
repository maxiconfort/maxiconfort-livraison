# MAXICONFORT — Installation de l'agent d'impression GLS
#
# Place un raccourci dans le dossier "Demarrage" de la session Windows (aucun droit
# administrateur necessaire) : l'agent demarre a chaque ouverture de session, sans
# fenetre visible. Puis lance l'agent tout de suite.
#
# Pour l installer  :  powershell -ExecutionPolicy Bypass -File print-agent\config\installer-agent.ps1
# Pour le retirer   :  supprimer "Maxiconfort - Impression GLS.lnk" dans shell:startup
# Pour l arreter    :  Gestionnaire des taches → terminer le processus node.exe dont la ligne
#                      de commande contient "agent-impression.js" (ne pas tuer le bot Telegram !)

$nom = "Maxiconfort - Impression GLS"
$lanceur = "C:\Users\moind\maxiconfort-livraison\print-agent\config\lancer-agent-cache.vbs"
$dossierDemarrage = [Environment]::GetFolderPath('Startup')
$raccourci = Join-Path $dossierDemarrage "$nom.lnk"

if (-not (Test-Path $lanceur)) {
  Write-Output "Fichier de lancement introuvable : $lanceur"
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($raccourci)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$lanceur`""
$lnk.WorkingDirectory = "C:\Users\moind\maxiconfort-livraison"
$lnk.Description = "Imprime automatiquement les etiquettes GLS creees dans l'app Livraison"
$lnk.WindowStyle = 7
$lnk.Save()
Write-Output "Raccourci de demarrage cree : $raccourci"

# Deja en cours ? (on ne lance pas deux agents)
$dejaLance = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent-impression.js*' }
if ($dejaLance) {
  Write-Output "L'agent tourne deja (PID $($dejaLance.ProcessId)). Rien a relancer."
} else {
  Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList "`"$lanceur`""
  Write-Output "Agent lance maintenant (fenetre cachee). Journal : print-agent\journal\"
}
