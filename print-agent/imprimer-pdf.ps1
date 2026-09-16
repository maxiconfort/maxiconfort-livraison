# MAXICONFORT — Impression silencieuse d'un PDF d'étiquette, 100 % Windows (sans Adobe ni logiciel tiers)
#
# Méthode : Windows rend chaque page du PDF en image (composant natif Windows.Data.Pdf, présent
# sur Windows 10/11), puis l'image est envoyée à l'imprimante via .NET (System.Drawing.Printing)
# sur le papier 4x6" (101,6 x 152,4 mm) du pilote, sans marge, à l'échelle exacte.
#
# Usage : powershell -NoProfile -ExecutionPolicy Bypass -File imprimer-pdf.ps1 -Fichier "C:\...\GLS_1234.pdf" [-Imprimante "PM-344-WF (WiFi)"]
# Code de sortie : 0 = envoyé au spouleur Windows, autre = erreur (message sur la sortie standard)

param(
  [Parameter(Mandatory = $true)][string]$Fichier,
  [string]$Imprimante = 'PM-344-WF (WiFi)',
  [int]$Dpi = 300
)

$ErrorActionPreference = 'Stop'
try {
  if (-not (Test-Path -LiteralPath $Fichier)) { throw "Fichier introuvable : $Fichier" }
  $chemin = (Resolve-Path -LiteralPath $Fichier).Path

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

  # ── Petit pont WinRT async → PowerShell synchrone ─────────────────────
  $methodes = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $asTaskOp = ($methodes | Where-Object { $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTaskAction = ($methodes | Where-Object { -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  function Attendre($op, $type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  function AttendreAction($act) { $t = $asTaskAction.Invoke($null, @($act)); $t.Wait(-1) | Out-Null }

  # ── 1. Rendu des pages en images ──────────────────────────────────────
  $fichierWinRT = Attendre ([Windows.Storage.StorageFile]::GetFileFromPathAsync($chemin)) ([Windows.Storage.StorageFile])
  $pdf = Attendre ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($fichierWinRT)) ([Windows.Data.Pdf.PdfDocument])
  if ($pdf.PageCount -lt 1) { throw 'PDF sans page' }

  $largeurCible = [uint32][math]::Round(100 / 25.4 * $Dpi)   # 100 mm de large → pixels
  $images = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $pdf.PageCount; $i++) {
    $page = $pdf.GetPage($i)
    $ratio = $page.Size.Height / $page.Size.Width
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = $largeurCible
    $opts.DestinationHeight = [uint32][math]::Round($largeurCible * $ratio)
    $flux = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AttendreAction ($page.RenderToStreamAsync($flux, $opts))
    $lecteur = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($flux)
    $mem = New-Object System.IO.MemoryStream
    $lecteur.CopyTo($mem); $mem.Position = 0
    [void]$images.Add([System.Drawing.Image]::FromStream($mem))
    $page.Dispose(); $flux.Dispose()
  }

  # ── 2. Impression ─────────────────────────────────────────────────────
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $Imprimante
  if (-not $doc.PrinterSettings.IsValid) { throw "Imprimante Windows introuvable : $Imprimante" }
  $doc.DocumentName = 'Etiquette GLS ' + (Split-Path $chemin -Leaf)
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController   # aucune fenêtre
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
  $doc.OriginAtMargins = $false
  $doc.DefaultPageSettings.Landscape = $false

  # Papier 4x6" (dimensions en centièmes de pouce : 400 x 600)
  $papier = $doc.PrinterSettings.PaperSizes | Where-Object { $_.Width -ge 390 -and $_.Width -le 410 -and $_.Height -ge 590 -and $_.Height -le 610 } | Select-Object -First 1
  if (-not $papier) { $papier = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like '4.00*6.00*' } | Select-Object -First 1 }
  if ($papier) { $doc.DefaultPageSettings.PaperSize = $papier }

  $script:index = 0
  $doc.add_PrintPage({
      param($expediteur, $e)
      $img = $images[$script:index]
      $zone = $e.PageBounds   # centièmes de pouce, marges à zéro
      $echelle = [math]::Min($zone.Width / $img.Width, $zone.Height / $img.Height)
      $l = $img.Width * $echelle; $h = $img.Height * $echelle
      $x = ($zone.Width - $l) / 2; $y = ($zone.Height - $h) / 2
      $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $e.Graphics.DrawImage($img, [single]$x, [single]$y, [single]$l, [single]$h)
      $script:index++
      $e.HasMorePages = ($script:index -lt $images.Count)
    })
  $doc.Print()

  foreach ($img in $images) { $img.Dispose() }
  $nomPapier = if ($papier) { $papier.PaperName } else { 'papier par defaut du pilote' }
  Write-Output ("OK {0} page(s) envoyee(s) a '{1}' sur {2}" -f $images.Count, $Imprimante, $nomPapier)
  exit 0
}
catch {
  Write-Output ("ERREUR " + $_.Exception.Message)
  exit 1
}
