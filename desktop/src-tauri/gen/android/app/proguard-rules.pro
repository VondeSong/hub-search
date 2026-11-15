# Add project specific ProGuard rules here.
# Rust calls this generated activity method through JNI, so R8 cannot infer it.
# Keep it even when Windows packaging restores generated Kotlin sources manually.
-keep class com.craftsearch.desktop.TauriActivity {
    public app.tauri.plugin.PluginManager getPluginManager();
}
-keep class com.craftsearch.desktop.QuickJournalWorker { *; }
-keep class com.craftsearch.desktop.QuickJournalWorker$Companion { *; }
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
