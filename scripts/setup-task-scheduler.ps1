# 윈도우 작업 스케줄러에 매일 아침 06:00, 저녁 22:00 자동 발행 작업을 등록합니다.
# 사용법: 이 파일을 우클릭 > "PowerShell로 실행" 하거나,
#         PowerShell에서  powershell -ExecutionPolicy Bypass -File scripts\setup-task-scheduler.ps1

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$script = Join-Path $projectDir 'src\main.js'

Write-Host "프로젝트 경로: $projectDir"
Write-Host "node 경로: $node"

function Register-PostTask($name, $time) {
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --slot auto" -WorkingDirectory $projectDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -DontStopOnIdleEnd
    # -StartWhenAvailable: 예약 시각에 PC가 꺼져 있었다면 켜진 직후 실행

    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
        -Description "AI Tistory Writer 자동 발행" | Out-Null
    Write-Host "✅ 등록: $name ($time)"
}

Register-PostTask 'AI_Tistory_Morning' '06:00'
Register-PostTask 'AI_Tistory_Evening' '22:00'

Write-Host ""
Write-Host "완료! 등록된 작업 확인: schtasks /query /tn AI_Tistory_Morning"
Write-Host "수동 실행 테스트:     schtasks /run /tn AI_Tistory_Morning"
Write-Host "삭제하려면:           Unregister-ScheduledTask -TaskName AI_Tistory_Morning -Confirm:`$false"
