param([int]$DesktopPid, [string]$Selection, [ValidateSet("cancel", "select")][string]$Mode)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DialogFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $DesktopPid)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Choose workspace directory"))
)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
while ($null -eq $dialog -and [DateTime]::UtcNow -lt $deadline) {
  $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  if ($null -eq $dialog) { [System.Threading.Tasks.Task]::Delay(100).Wait() }
}
if ($null -eq $dialog) { throw "Native folder dialog not found" }
[void][DialogFocus]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)
if ($Mode -eq "cancel") {
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
} else {
  [System.Windows.Forms.SendKeys]::SendWait("^l")
  [System.Windows.Forms.SendKeys]::SendWait($Selection)
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  [System.Threading.Tasks.Task]::Delay(500).Wait()
  $buttonCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "1")),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
  )
  $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  if ($null -eq $button) { throw "Native folder confirmation button not found" }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}