HUB Windows + Android 图标包

内容说明
--------
1. Windows/
   - HUB.ico：Windows 可直接使用的多尺寸图标
   - HUB_256.png / HUB_512.png
   - PNG/：各尺寸 PNG

2. Android/
   - app/src/main/res/mipmap-*：传统启动图标
   - app/src/main/res/mipmap-anydpi-v26/：Adaptive Icon XML
   - app/src/main/res/drawable-*/ic_launcher_foreground.png：Adaptive Icon 前景图
   - Play_Store/HUB_Play_Store_512.png：Google Play 商店图标

3. master/
   - HUB_master_1024.png：高清母图

Android 使用
-----------
Manifest 常用写法：
android:icon="@mipmap/ic_launcher"
android:roundIcon="@mipmap/ic_launcher_round"

Windows 使用
-----------
优先使用：
Windows/HUB.ico
