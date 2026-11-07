Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Collections.Generic;
public class HubIconCrop {
 public static void Run(string path) {
  using(var src=new Bitmap(path)) using(var bmp=new Bitmap(src)) {
   int w=bmp.Width,h=bmp.Height; var seen=new bool[w*h]; var q=new Queue<int>();
   for(int x=0;x<w;x++){q.Enqueue(x);q.Enqueue((h-1)*w+x);} for(int y=0;y<h;y++){q.Enqueue(y*w);q.Enqueue(y*w+w-1);}
   while(q.Count>0){int i=q.Dequeue();if(seen[i])continue;seen[i]=true;int x=i%w,y=i/w;Color c=bmp.GetPixel(x,y);
    if(c.A!=0 && !(c.R>=230 && c.G>=230 && c.B>=230))continue;
    bmp.SetPixel(x,y,Color.FromArgb(0,c.R,c.G,c.B));
    if(x>0)q.Enqueue(i-1);if(x<w-1)q.Enqueue(i+1);if(y>0)q.Enqueue(i-w);if(y<h-1)q.Enqueue(i+w);
   }
   bmp.Save(path+".tmp",System.Drawing.Imaging.ImageFormat.Png);
  }
  System.IO.File.Copy(path+".tmp",path,true);System.IO.File.Delete(path+".tmp");
 }
}
"@
$root=Split-Path $PSScriptRoot
$pack='D:\01 Downloads\HUB_All_Platform_Icon_Pack\HUB_All_Platform_Icon_Pack'
$temp=Join-Path $env:TEMP 'hub-pack-transparent'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$sizes=@(256,128,96,64,48,40,32,24,20,16)
foreach($size in $sizes){$dest=Join-Path $temp "$size.png";Copy-Item -LiteralPath "$pack\Windows\PNG\HUB_${size}x${size}.png" -Destination $dest;[HubIconCrop]::Run($dest)}
foreach($pair in @(@(32,'32x32.png'),@(64,'64x64.png'),@(128,'128x128.png'),@(256,'128x128@2x.png'))){Copy-Item -LiteralPath "$temp\$($pair[0]).png" -Destination "$root\src-tauri\icons\$($pair[1])"}
Copy-Item -LiteralPath "$pack\Windows\HUB_512.png" -Destination "$root\src-tauri\icons\icon.png"
[HubIconCrop]::Run("$root\src-tauri\icons\icon.png")
Copy-Item -LiteralPath "$temp\48.png" -Destination "$root\public\icons\hub.png"
Copy-Item -LiteralPath "$temp\96.png" -Destination "$root\public\icons\hub@2x.png"
$stream=[IO.File]::Create("$root\src-tauri\icons\icon.ico");$w=[IO.BinaryWriter]::new($stream)
$w.Write([uint16]0);$w.Write([uint16]1);$w.Write([uint16]$sizes.Count);$offset=6+16*$sizes.Count;$payloads=@()
foreach($size in $sizes){$bytes=[IO.File]::ReadAllBytes("$temp\$size.png");$payloads+=,$bytes;$d=if($size -eq 256){0}else{$size};$w.Write([byte]$d);$w.Write([byte]$d);$w.Write([byte]0);$w.Write([byte]0);$w.Write([uint16]1);$w.Write([uint16]32);$w.Write([uint32]$bytes.Length);$w.Write([uint32]$offset);$offset+=$bytes.Length}
foreach($bytes in $payloads){$w.Write([byte[]]$bytes)};$w.Dispose();$stream.Dispose()
