# MAXICONFORT — Installation de l'agent d'impression GLS
#
# Cree une tache Windows qui demarre l'agent a chaque ouverture de session,
# sans fenetre visible, et le lance tout de suite.
# Ne demande aucun droit administrateur : la tache tourne sous ton compte.
#
# Pour l installer  :  powershell -ExecutionPolicy Bypass -File print-agent\config\installer-agent.ps1
# Pour la supprimer :  schtasks /delete /tn "Maxiconfort - Impression GLS" /f
# Pour l arreter    :  taskkill /f /im node.exe   (arrete aussi les autres agents Node !)

$nom = "Maxiconfort - Impression GLS"
$lanceur = "C:\Users\moind\maxiconfort-livraison\print-agent\config\lancer-agent-cache.vbs"

if (-not (Test-Path $lanceur)) {
  Write-Output "Fichier de lancement introuvable : $lanceur"
  exit 1
}

$commande = "wscript.exe `"$lanceur`""

$existe = schtasks /query /tn "$nom" 2>$null
if ($existe) {
  schtasks /delete /tn "$nom" /f | Out-Null
  Write-Output "Ancienne tache remplacee."
}

schtasks /create `
  /tn "$nom" `
  /tr "$commande" `
  /sc onlogon `
  /f | Out-Null

if ($LASTEXITCODE -eq 0) {
  Write-Output "Agent installe : il demarre a chaque ouverture de session Windows."
  schtasks /run /tn "$nom" | Out-Null
  Write-Output "Agent lance maintenant. Journal : print-agent\journal\"
} else {
  Write-Output "La creation de la tache a echoue (code $LASTEXITCODE)."
}
