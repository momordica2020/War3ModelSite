Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$modelsDir = Join-Path $projectRoot "Models"
$translationsFile = Join-Path $projectRoot "src\model-translations.json"
$indexScript = Join-Path $projectRoot "scripts\generate-models-index.js"

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "War3 自定义模型上传工具"
$form.Size = New-Object System.Drawing.Size(720, 560)
$form.StartPosition = "CenterScreen"
$form.BackColor = [System.Drawing.Color]::FromArgb(26, 26, 46)
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)

function Get-MdxFiles {
    param([string]$FolderPath)
    $files = @()
    if (Test-Path $FolderPath) {
        $mdxFiles = Get-ChildItem -Path $FolderPath -Filter "*.mdx" -File -ErrorAction SilentlyContinue
        $MDXFiles = Get-ChildItem -Path $FolderPath -Filter "*.MDX" -File -ErrorAction SilentlyContinue
        $files = $mdxFiles + $MDXFiles
    }
    return $files
}

function Update-Translations {
    param([string[]]$ModelNames)
    $translations = @{}
    if (Test-Path $translationsFile) {
        $content = Get-Content $translationsFile -Raw -Encoding UTF8
        if ($content) {
            try {
                $translations = $content | ConvertFrom-Json -AsHashtable
            } catch {
                $translations = @{}
            }
        }
    }
    
    $added = 0
    foreach ($name in $ModelNames) {
        if (-not $translations.ContainsKey($name)) {
            $translations[$name] = ""
            $added++
        }
    }
    
    $json = $translations | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($translationsFile, $json + "`n", [System.Text.Encoding]::UTF8)
    
    return $added
}

function Rebuild-Index {
    param([bool]$Silent = $false)
    $statusLabel.Text = "正在重建模型索引..."
    $form.Update()
    
    try {
        $process = Start-Process -FilePath "node" -ArgumentList $indexScript -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru
        if ($process.ExitCode -eq 0) {
            if (-not $Silent) {
                [System.Windows.Forms.MessageBox]::Show("模型索引已重建", "完成", "OK", "Information")
            }
            $statusLabel.Text = "索引重建完成"
        } else {
            if (-not $Silent) {
                [System.Windows.Forms.MessageBox]::Show("索引重建失败", "错误", "OK", "Error")
            }
            $statusLabel.Text = "索引重建失败"
        }
    } catch {
        if (-not $Silent) {
            [System.Windows.Forms.MessageBox]::Show("执行失败: $_", "错误", "OK", "Error")
        }
        $statusLabel.Text = "执行失败"
    }
}

function Refresh-ModelList {
    $treeView.BeginUpdate()
    $treeView.Nodes.Clear()
    
    if (Test-Path $modelsDir) {
        $folders = Get-ChildItem -Path $modelsDir -Directory | Sort-Object Name
        foreach ($folder in $folders) {
            $mdxFiles = Get-MdxFiles -FolderPath $folder.FullName
            $status = if ($mdxFiles.Count -gt 0) { "就绪" } else { "无模型" }
            
            $node = New-Object System.Windows.Forms.TreeNode
            $node.Text = "$($folder.Name)  ($($mdxFiles.Count) 个 MDX)  [$status]"
            $node.Tag = $folder.Name
            $treeView.Nodes.Add($node)
        }
    }
    
    $treeView.EndUpdate()
}

function Remove-Translations {
    param([string[]]$ModelNames)
    if (-not $ModelNames -or $ModelNames.Count -eq 0) { return }
    
    if (Test-Path $translationsFile) {
        $content = Get-Content $translationsFile -Raw -Encoding UTF8
        if ($content) {
            $translations = $content | ConvertFrom-Json -AsHashtable
            $removed = 0
            foreach ($name in $ModelNames) {
                if ($translations.ContainsKey($name)) {
                    $translations.Remove($name)
                    $removed++
                }
            }
            
            $json = $translations | ConvertTo-Json -Depth 10
            [System.IO.File]::WriteAllText($translationsFile, $json + "`n", [System.Text.Encoding]::UTF8)
            
            if ($removed -gt 0) {
                $statusLabel.Text = "已从翻译表移除 $removed 个条目"
            }
        }
    }
}

# UI Elements
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "War3 自定义模型上传"
$titleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei", 16, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(233, 69, 96)
$titleLabel.BackColor = [System.Drawing.Color]::FromArgb(26, 26, 46)
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(200, 10)
$form.Controls.Add($titleLabel)

$descLabel = New-Object System.Windows.Forms.Label
$descLabel.Text = "选择一个包含 .mdx 模型的文件夹，将自动复制到项目并更新索引"
$descLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$descLabel.BackColor = [System.Drawing.Color]::FromArgb(26, 26, 46)
$descLabel.AutoSize = $true
$descLabel.Location = New-Object System.Drawing.Point(120, 45)
$form.Controls.Add($descLabel)

$folderFrame = New-Object System.Windows.Forms.Panel
$folderFrame.BackColor = [System.Drawing.Color]::FromArgb(22, 33, 62)
$folderFrame.Location = New-Object System.Drawing.Point(20, 75)
$folderFrame.Size = New-Object System.Drawing.Size(660, 45)
$form.Controls.Add($folderFrame)

$folderTextBox = New-Object System.Windows.Forms.TextBox
$folderTextBox.Font = New-Object System.Drawing.Font("Microsoft YaHei", 10)
$folderTextBox.BackColor = [System.Drawing.Color]::FromArgb(15, 52, 96)
$folderTextBox.ForeColor = [System.Drawing.Color]::White
$folderTextBox.BorderStyle = "None"
$folderTextBox.Location = New-Object System.Drawing.Point(10, 13)
$folderTextBox.Size = New-Object System.Drawing.Size(540, 23)
$folderFrame.Controls.Add($folderTextBox)

$browseBtn = New-Object System.Windows.Forms.Button
$browseBtn.Text = "浏览..."
$browseBtn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$browseBtn.BackColor = [System.Drawing.Color]::FromArgb(233, 69, 96)
$browseBtn.ForeColor = [System.Drawing.Color]::White
$browseBtn.FlatStyle = "Flat"
$browseBtn.Cursor = "Hand"
$browseBtn.Location = New-Object System.Drawing.Point(560, 8)
$browseBtn.Size = New-Object System.Drawing.Size(85, 28)
$browseBtn.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "选择包含模型的文件夹"
    if ($dialog.ShowDialog() -eq "OK") {
        $folderTextBox.Text = $dialog.SelectedPath
    }
})
$folderFrame.Controls.Add($browseBtn)

$uploadBtn = New-Object System.Windows.Forms.Button
$uploadBtn.Text = "📤 上传模型"
$uploadBtn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 11, [System.Drawing.FontStyle]::Bold)
$uploadBtn.BackColor = [System.Drawing.Color]::FromArgb(15, 52, 96)
$uploadBtn.ForeColor = [System.Drawing.Color]::White
$uploadBtn.FlatStyle = "Flat"
$uploadBtn.Cursor = "Hand"
$uploadBtn.Location = New-Object System.Drawing.Point(20, 130)
$uploadBtn.Size = New-Object System.Drawing.Size(140, 40)
$uploadBtn.Add_Click({
    $sourcePath = $folderTextBox.Text.Trim()
    if (-not $sourcePath) {
        [System.Windows.Forms.MessageBox]::Show("请先选择一个文件夹", "提示", "OK", "Warning")
        return
    }
    
    if (-not (Test-Path $sourcePath)) {
        [System.Windows.Forms.MessageBox]::Show("所选路径不是文件夹", "错误", "OK", "Error")
        return
    }
    
    $mdxFiles = Get-MdxFiles -FolderPath $sourcePath
    if ($mdxFiles.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show("所选文件夹中没有找到 .mdx 文件", "错误", "OK", "Error")
        return
    }
    
    $folderName = Split-Path $sourcePath -Leaf
    $destPath = Join-Path $modelsDir $folderName
    
    if (Test-Path $destPath) {
        $result = [System.Windows.Forms.MessageBox]::Show("目标文件夹 `"$folderName`" 已存在，是否覆盖？", "确认覆盖", "YesNo", "Question")
        if ($result -ne "Yes") { return }
        Remove-Item -Path $destPath -Recurse -Force
    }
    
    $statusLabel.Text = "正在复制 $($mdxFiles.Count) 个 MDX 文件..."
    $form.Update()
    
    Copy-Item -Path $sourcePath -Destination $destPath -Recurse
    
    $modelNames = $mdxFiles | ForEach-Object { $_.BaseName }
    $added = Update-Translations -ModelNames $modelNames
    
    Rebuild-Index -Silent $true
    Refresh-ModelList
    
    $statusLabel.Text = "完成！已上传 $folderName（$($mdxFiles.Count) 个模型）"
    [System.Windows.Forms.MessageBox]::Show("已成功上传模型文件夹：`n`n📁 $folderName`n📦 MDX 文件数：$($mdxFiles.Count)`n`n模型索引和翻译表已更新。", "上传成功", "OK", "Information")
})
$form.Controls.Add($uploadBtn)

$rebuildBtn = New-Object System.Windows.Forms.Button
$rebuildBtn.Text = "🔄 重建索引"
$rebuildBtn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 11)
$rebuildBtn.BackColor = [System.Drawing.Color]::FromArgb(83, 52, 131)
$rebuildBtn.ForeColor = [System.Drawing.Color]::White
$rebuildBtn.FlatStyle = "Flat"
$rebuildBtn.Cursor = "Hand"
$rebuildBtn.Location = New-Object System.Drawing.Point(170, 130)
$rebuildBtn.Size = New-Object System.Drawing.Size(120, 40)
$rebuildBtn.Add_Click({ Rebuild-Index })
$form.Controls.Add($rebuildBtn)

$listLabel = New-Object System.Windows.Forms.Label
$listLabel.Text = "当前自定义模型列表："
$listLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei", 10, [System.Drawing.FontStyle]::Bold)
$listLabel.ForeColor = [System.Drawing.Color]::White
$listLabel.BackColor = [System.Drawing.Color]::FromArgb(26, 26, 46)
$listLabel.AutoSize = $true
$listLabel.Location = New-Object System.Drawing.Point(20, 185)
$form.Controls.Add($listLabel)

$treeView = New-Object System.Windows.Forms.TreeView
$treeView.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$treeView.BackColor = [System.Drawing.Color]::FromArgb(15, 52, 96)
$treeView.ForeColor = [System.Drawing.Color]::White
$treeView.BorderStyle = "None"
$treeView.Location = New-Object System.Drawing.Point(20, 215)
$treeView.Size = New-Object System.Drawing.Size(620, 230)
$treeView.ItemHeight = 22
$form.Controls.Add($treeView)

$scrollBar = New-Object System.Windows.Forms.VScrollBar
$scrollBar.Location = New-Object System.Drawing.Point(640, 215)
$scrollBar.Size = New-Object System.Drawing.Size(20, 230)
$treeView.Scrollable = $true
$form.Controls.Add($scrollBar)

$deleteBtn = New-Object System.Windows.Forms.Button
$deleteBtn.Text = "🗑 删除选中"
$deleteBtn.Font = New-Object System.Drawing.Font("Microsoft YaHei", 10)
$deleteBtn.BackColor = [System.Drawing.Color]::FromArgb(139, 0, 0)
$deleteBtn.ForeColor = [System.Drawing.Color]::White
$deleteBtn.FlatStyle = "Flat"
$deleteBtn.Cursor = "Hand"
$deleteBtn.Location = New-Object System.Drawing.Point(20, 455)
$deleteBtn.Size = New-Object System.Drawing.Size(120, 35)
$deleteBtn.Add_Click({
    if ($treeView.SelectedNode -eq $null) {
        [System.Windows.Forms.MessageBox]::Show("请先选择要删除的模型文件夹", "提示", "OK", "Warning")
        return
    }
    
    $folderName = $treeView.SelectedNode.Tag
    $folderPath = Join-Path $modelsDir $folderName
    
    $result = [System.Windows.Forms.MessageBox]::Show("确定要删除文件夹 `"$folderName`" 及其所有文件吗？`n此操作不可恢复。", "确认删除", "YesNo", "Warning")
    if ($result -ne "Yes") { return }
    
    $modelNames = @()
    if (Test-Path $folderPath) {
        $mdxFiles = Get-MdxFiles -FolderPath $folderPath
        $modelNames = $mdxFiles | ForEach-Object { $_.BaseName }
        Remove-Item -Path $folderPath -Recurse -Force
    }
    
    Remove-Translations -ModelNames $modelNames
    Rebuild-Index -Silent $true
    Refresh-ModelList
    $statusLabel.Text = "已删除：$folderName"
})
$form.Controls.Add($deleteBtn)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "就绪"
$statusLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
$statusLabel.BackColor = [System.Drawing.Color]::FromArgb(15, 52, 96)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(10, 520)
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(10, 3, 10, 3)
$form.Controls.Add($statusLabel)

Refresh-ModelList

[System.Windows.Forms.Application]::Run($form)
