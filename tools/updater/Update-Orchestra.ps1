[CmdletBinding(DefaultParameterSetName = 'Repo')]
param(
    [Parameter(ParameterSetName = 'Repo')][string]$Repo = (Get-Location).Path,
    [Parameter(Mandatory = $true, ParameterSetName = 'Package')][string]$Package,
    [string]$Dsh,
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [Parameter(ParameterSetName = 'Package')][string]$Sha256,
    [Parameter(ParameterSetName = 'Repo')][switch]$Test,
    [switch]$Plan,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22.19+ is required. Install Node or use the existing development environment.'
}
$nodeArgs = @((Join-Path $PSScriptRoot 'update-dsh-orchestra.mjs'), '--profile', $Profile)
if ($PSCmdlet.ParameterSetName -eq 'Package') { $nodeArgs += @('--package', $Package) }
else { $nodeArgs += @('--repo', $Repo) }
if ($Dsh) { $nodeArgs += @('--dsh', $Dsh) }
if ($DshHome) { $nodeArgs += @('--dsh-home', $DshHome) }
if ($Sha256) { $nodeArgs += @('--sha256', $Sha256) }
if ($Test) { $nodeArgs += '--test' }
if ($Plan) { $nodeArgs += '--plan' }
if ($Json) { $nodeArgs += '--json' }
& node @nodeArgs
exit $LASTEXITCODE
